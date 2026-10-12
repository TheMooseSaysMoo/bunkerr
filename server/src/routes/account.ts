import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';
import {
  HttpError, SESSION_COOKIE, createSession, firstHousehold, hashPassword, randomToken, requireUser, sha256,
  validatePassword, verifyPassword, type Role, type UserRow,
} from '../auth.js';
import { config } from '../config.js';
import { getSettings } from '../settings.js';
import { parse } from '../util.js';

interface InviteRow { id: number; household_id: number | null; role: Role; expires_at: number; used_by: number | null; revoked: number; household_name: string | null; email: string | null }

export function findInvite(deps: AppDeps, token: string): InviteRow {
  const inv = deps.db.prepare(`SELECT i.id, i.household_id, i.role, i.expires_at, i.used_by, i.revoked, i.email, h.name AS household_name
    FROM invites i LEFT JOIN households h ON h.id = i.household_id WHERE i.token_hash = ?`).get(sha256(token)) as InviteRow | undefined;
  if (!inv || inv.revoked || inv.used_by != null || inv.expires_at < Date.now()) throw new HttpError(410, 'Invite is invalid, expired or already used');
  return inv;
}

/** Applies an invite to a user inside the caller's transaction. Returns the household joined/created. */
function applyInvite(deps: AppDeps, inv: InviteRow, userId: number, newHouseholdName: string): number {
  const { db } = deps;
  const t = Date.now();
  let hh = inv.household_id;
  if (hh == null) {
    hh = Number(db.prepare('INSERT INTO households (name,created_at) VALUES (?,?)').run(newHouseholdName, t).lastInsertRowid);
  }
  db.prepare(`INSERT INTO memberships (user_id,household_id,role,created_at) VALUES (?,?,?,?)
    ON CONFLICT(user_id,household_id) DO NOTHING`).run(userId, hh, inv.household_id == null ? 'owner' : inv.role, t);
  // Guard against a concurrent double-use.
  const used = db.prepare('UPDATE invites SET used_by=?, used_at=? WHERE id=? AND used_by IS NULL').run(userId, t, inv.id);
  if (used.changes !== 1) throw new HttpError(410, 'Invite already used');
  return hh;
}

export const armoryVisibleTo = (s: { armoryEnabled: boolean; armoryViewers: boolean }, role: Role) => s.armoryEnabled && (role !== 'viewer' || s.armoryViewers);

export function meResponse(deps: AppDeps, userId: number, activeHh: number | null) {
  const { db } = deps;
  const user = db.prepare('SELECT id,email,name,is_admin FROM users WHERE id=?').get(userId) as { id: number; email: string; name: string; is_admin: number };
  const households = db.prepare(`SELECT h.id, h.name, m.role FROM memberships m JOIN households h ON h.id=m.household_id
    WHERE m.user_id=? ORDER BY h.name`).all(userId) as { id: number; name: string; role: Role }[];
  const active = households.find((h) => h.id === activeHh) ?? null;
  return {
    user: { id: user.id, email: user.email, name: user.name, isAdmin: !!user.is_admin },
    households,
    active,
    armoryVisible: !!active && armoryVisibleTo(getSettings(db, active.id), active.role),
    links: active ? (db.prepare(`SELECT COUNT(*) AS n FROM links WHERE household_id=?`).get(active.id) as { n: number }).n : 0,
    instance: deps.ha.status(),
    features: { router: !!config.webhookRouterUrl, photoImport: !!deps.extractor, mesh: !!config.mqttUrl, barcodeProducts: deps.barcodes?.status().products ?? 0, email: deps.mailer.ready(), links: deps.federation.enabled },
  };
}

export default async function accountRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;

  app.post('/api/auth/login', { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } }, async (req, reply) => {
    const body = parse(z.object({ email: z.string().trim().min(3), password: z.string().min(1) }), req.body);
    const u = db.prepare('SELECT * FROM users WHERE lower(email)=lower(?)').get(body.email) as UserRow | undefined;
    // Verify against a dummy hash when the user doesn't exist to keep timing similar.
    const ok = u ? await verifyPassword(u.pw_hash, body.password) : (await verifyPassword(DUMMY_HASH, body.password), false);
    if (!u || !ok || u.disabled) throw new HttpError(401, 'Invalid email or password');
    const hh = firstHousehold(db, u.id);
    createSession(db, reply, u.id, hh);
    return meResponse(deps, u.id, hh);
  });

  app.post('/api/auth/logout', async (req, reply) => {
    if (req.ctx) db.prepare('DELETE FROM sessions WHERE id=?').run(req.ctx.sessionId);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', async (req) => {
    const ctx = requireUser(req);
    return meResponse(deps, ctx.user.id, ctx.householdId);
  });

  app.get('/api/invites/:token', async (req) => {
    const { token } = parse(z.object({ token: z.string().min(10).max(100) }), req.params);
    const inv = findInvite(deps, token);
    return { householdName: inv.household_name, newHousehold: inv.household_id == null, role: inv.household_id == null ? 'owner' : inv.role, email: inv.email };
  });

  app.post('/api/auth/register', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (req, reply) => {
    const body = parse(z.object({
      token: z.string().min(10).max(100),
      email: z.email().max(200),
      name: z.string().trim().min(1).max(60),
      password: z.string(),
      householdName: z.string().trim().max(60).optional(),
    }), req.body);
    validatePassword(body.password);
    const inv = findInvite(deps, body.token);
    if (db.prepare('SELECT 1 FROM users WHERE lower(email)=lower(?)').get(body.email)) throw new HttpError(409, 'An account with that email exists — log in and open the invite link instead');
    const pwHash = await hashPassword(body.password);
    const { userId, hh } = db.transaction(() => {
      const userId = Number(db.prepare('INSERT INTO users (email,name,pw_hash,created_at) VALUES (?,?,?,?)').run(body.email, body.name, pwHash, Date.now()).lastInsertRowid);
      const hh = applyInvite(deps, inv, userId, body.householdName || `${body.name}'s household`);
      return { userId, hh };
    })();
    createSession(db, reply, userId, hh);
    return meResponse(deps, userId, hh);
  });

  app.post('/api/invites/accept', async (req) => {
    const ctx = requireUser(req);
    const body = parse(z.object({ token: z.string().min(10).max(100), householdName: z.string().trim().max(60).optional() }), req.body);
    const inv = findInvite(deps, body.token);
    const hh = db.transaction(() => applyInvite(deps, inv, ctx.user.id, body.householdName || `${ctx.user.name}'s household`))();
    db.prepare('UPDATE sessions SET household_id=? WHERE id=?').run(hh, ctx.sessionId);
    return meResponse(deps, ctx.user.id, hh);
  });

  app.post('/api/households/switch', async (req) => {
    const ctx = requireUser(req);
    const { householdId } = parse(z.object({ householdId: z.number().int() }), req.body);
    const m = db.prepare('SELECT 1 FROM memberships WHERE user_id=? AND household_id=?').get(ctx.user.id, householdId);
    if (!m) throw new HttpError(404, 'Household not found');
    db.prepare('UPDATE sessions SET household_id=? WHERE id=?').run(householdId, ctx.sessionId);
    return meResponse(deps, ctx.user.id, householdId);
  });

  app.post('/api/me/password', async (req) => {
    const ctx = requireUser(req);
    const body = parse(z.object({ current: z.string(), next: z.string() }), req.body);
    validatePassword(body.next);
    const u = db.prepare('SELECT pw_hash FROM users WHERE id=?').get(ctx.user.id) as { pw_hash: string };
    if (!(await verifyPassword(u.pw_hash, body.current))) throw new HttpError(400, 'Current password is wrong');
    db.prepare('UPDATE users SET pw_hash=? WHERE id=?').run(await hashPassword(body.next), ctx.user.id);
    db.prepare('DELETE FROM sessions WHERE user_id=? AND id<>?').run(ctx.user.id, ctx.sessionId);
    return { ok: true };
  });

  app.patch('/api/me', async (req) => {
    const ctx = requireUser(req);
    const body = parse(z.object({ name: z.string().trim().min(1).max(60) }), req.body);
    db.prepare('UPDATE users SET name=? WHERE id=?').run(body.name, ctx.user.id);
    return meResponse(deps, ctx.user.id, ctx.householdId);
  });
}

// Real hash of a random string, verified when the email is unknown so both paths cost the same.
const DUMMY_HASH = await hashPassword(randomToken());
