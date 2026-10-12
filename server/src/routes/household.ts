import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';
import { HttpError, randomToken, requireHousehold, requireUser, sha256, type Role } from '../auth.js';
import { config } from '../config.js';
import { meResponse } from './account.js';
import { parse } from '../util.js';
import { renderAlert } from '../mailer.js';
import { seal, unseal } from '../secrets.js';

const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;
const MAX_OWNED_HOUSEHOLDS = 5;
/** Invite emails per person per day, admins excepted: an invite form is otherwise a way to spam anyone through our SMTP. */
export const INVITE_EMAILS_PER_DAY = 20;
const MAX_SENDS_PER_INVITE = 3;

export const inviteEmailSchema = z.union([z.email().max(200).transform((e) => e.trim().toLowerCase()), z.literal('').transform(() => undefined)]).optional();

export function createInvite(deps: AppDeps, createdBy: number, householdId: number | null, role: Role, note?: string, email?: string) {
  const token = randomToken(24);
  const t = Date.now();
  // The link is also kept sealed so it can be emailed again ("resend") without making a new one.
  const id = Number(deps.db.prepare('INSERT INTO invites (token_hash,household_id,role,note,created_by,created_at,expires_at,email,token_sealed) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(sha256(token), householdId, role, note ?? null, createdBy, t, t + INVITE_TTL_MS, email ?? null, seal(token)).lastInsertRowid);
  return { id, token, url: `${config.publicUrl}/#/join/${token}`, expiresAt: t + INVITE_TTL_MS };
}

interface InviteRow { id: number; household_id: number | null; role: Role; email: string | null; token_sealed: string | null; created_by: number; expires_at: number; used_by: number | null; revoked: number; email_count: number }

/**
 * Emails an invite's link. Never throws for email trouble: the invite still exists and the
 * link still works, so the caller reports { emailed: false, emailError } and shows the link.
 */
export async function emailInvite(deps: AppDeps, inviteId: number, sender: { id: number; name: string; email: string; isAdmin: boolean }, to?: string)
  : Promise<{ emailed: boolean; emailedTo?: string; emailError?: string }> {
  const { db, mailer } = deps;
  const inv = db.prepare('SELECT * FROM invites WHERE id=?').get(inviteId) as InviteRow | undefined;
  if (!inv || inv.revoked || inv.used_by != null || inv.expires_at < Date.now()) return { emailed: false, emailError: 'This invite is no longer valid' };
  const dest = to ?? inv.email;
  if (!dest) return { emailed: false, emailError: 'No email address on this invite' };
  if (!mailer.ready()) return { emailed: false, emailError: 'Email isn’t set up on this instance. Share the link instead.' };
  if (inv.email_count >= MAX_SENDS_PER_INVITE) return { emailed: false, emailError: `Already emailed ${inv.email_count} times. Share the link instead.` };
  if (!sender.isAdmin) {
    const today = (db.prepare('SELECT COALESCE(SUM(email_count),0) AS n FROM invites WHERE created_by=? AND emailed_at > ?').get(sender.id, Date.now() - 86400000) as { n: number }).n;
    if (today >= INVITE_EMAILS_PER_DAY) return { emailed: false, emailError: `Daily limit of ${INVITE_EMAILS_PER_DAY} invite emails reached. Share the link instead.` };
  }
  const token = unseal(inv.token_sealed);
  if (!token) return { emailed: false, emailError: 'This invite can’t be re-sent. Create a new one.' };
  const hh = inv.household_id == null ? null : db.prepare('SELECT name FROM households WHERE id=?').get(inv.household_id) as { name: string } | undefined;
  const url = `${config.publicUrl}/#/join/${token}`;
  const expires = new Date(inv.expires_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
  const title = hh ? `${sender.name} invited you to ${hh.name} on Bunkerr` : `${sender.name} invited you to Bunkerr`;
  const lines = [
    'Hi,',
    '',
    hh
      ? `${sender.name} (${sender.email}) invited you to join their household “${hh.name}” on Bunkerr as ${inv.role === 'viewer' ? 'a viewer (read-only)' : `a${inv.role === 'owner' ? 'n owner' : ' member'}`}.`
      : `${sender.name} (${sender.email}) invited you to start your own household on Bunkerr.`,
    'Bunkerr keeps track of emergency food, water and supplies, and warns you before things expire.',
    '',
    `Open the link to create your account. It works once and expires on ${expires}.`,
    '',
    'Not expecting this? Ignore it and nothing happens. Replying goes to the person who invited you.',
  ];
  try {
    await mailer.send({ to: dest, replyTo: sender.email, subject: `[Bunkerr] ${title}`, ...renderAlert({ title, lines, url }) });
  } catch (e) {
    return { emailed: false, emailError: `Couldn’t send: ${String((e as Error).message).slice(0, 200)}` };
  }
  db.prepare('UPDATE invites SET email=?, emailed_at=?, email_count=email_count+1 WHERE id=?').run(dest, Date.now(), inv.id);
  return { emailed: true, emailedTo: dest };
}

export default async function householdRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;

  const ownerCount = (hh: number) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM memberships WHERE household_id=? AND role='owner'`).get(hh) as { n: number }).n;

  app.get('/api/household', async (req) => {
    const hh = requireHousehold(req);
    const isOwner = req.ctx!.role === 'owner';
    const household = db.prepare('SELECT id,name,receipt_quota,created_at FROM households WHERE id=?').get(hh);
    const members = db.prepare(`SELECT u.id, u.name, u.email, m.role, m.created_at FROM memberships m JOIN users u ON u.id=m.user_id
      WHERE m.household_id=? ORDER BY m.created_at`).all(hh);
    const invites = isOwner
      ? db.prepare(`SELECT id, role, note, email, emailed_at, created_at, expires_at FROM invites WHERE household_id=? AND used_by IS NULL AND revoked=0 AND expires_at>?
          ORDER BY created_at DESC`).all(hh, Date.now())
      : [];
    return { household, members, invites };
  });

  app.post('/api/households', async (req) => {
    const ctx = requireUser(req);
    const { name } = parse(z.object({ name: z.string().trim().min(1).max(60) }), req.body);
    const owned = (db.prepare(`SELECT COUNT(*) AS n FROM memberships WHERE user_id=? AND role='owner'`).get(ctx.user.id) as { n: number }).n;
    if (owned >= MAX_OWNED_HOUSEHOLDS && !ctx.user.isAdmin) throw new HttpError(400, `You can own at most ${MAX_OWNED_HOUSEHOLDS} households`);
    const hh = db.transaction(() => {
      const t = Date.now();
      const id = Number(db.prepare('INSERT INTO households (name,created_at) VALUES (?,?)').run(name, t).lastInsertRowid);
      db.prepare(`INSERT INTO memberships (user_id,household_id,role,created_at) VALUES (?,?,'owner',?)`).run(ctx.user.id, id, t);
      return id;
    })();
    db.prepare('UPDATE sessions SET household_id=? WHERE id=?').run(hh, ctx.sessionId);
    return meResponse(deps, ctx.user.id, hh);
  });

  app.patch('/api/household', async (req) => {
    const hh = requireHousehold(req, 'owner');
    const { name } = parse(z.object({ name: z.string().trim().min(1).max(60) }), req.body);
    db.prepare('UPDATE households SET name=? WHERE id=?').run(name, hh);
    return { ok: true };
  });

  app.delete('/api/household', async (req) => {
    const hh = requireHousehold(req, 'owner');
    const { confirmName } = parse(z.object({ confirmName: z.string() }), req.body);
    const h = db.prepare('SELECT name FROM households WHERE id=?').get(hh) as { name: string };
    if (h.name !== confirmName) throw new HttpError(400, 'Type the household name exactly to confirm');
    db.prepare('DELETE FROM households WHERE id=?').run(hh); // cascades to all household data
    return { ok: true };
  });

  app.post('/api/household/invites', { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (req) => {
    const hh = requireHousehold(req, 'owner');
    const body = parse(z.object({ role: z.enum(['owner', 'member', 'viewer']).default('member'), note: z.string().max(100).optional(), email: inviteEmailSchema }), req.body);
    const inv = createInvite(deps, req.ctx!.user.id, hh, body.role, body.note, body.email);
    return { ...inv, ...(body.email ? await emailInvite(deps, inv.id, req.ctx!.user, body.email) : { emailed: false }) };
  });

  app.post('/api/household/invites/:id/resend', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req) => {
    const hh = requireHousehold(req, 'owner');
    const { id } = parse(z.object({ id: z.coerce.number().int() }), req.params);
    const { email } = parse(z.object({ email: inviteEmailSchema }), req.body ?? {});
    if (!db.prepare('SELECT 1 FROM invites WHERE id=? AND household_id=?').get(id, hh)) throw new HttpError(404, 'Invite not found');
    const r = await emailInvite(deps, id, req.ctx!.user, email);
    if (!r.emailed) throw new HttpError(409, r.emailError ?? 'Couldn’t send');
    return r;
  });

  app.delete('/api/household/invites/:id', async (req) => {
    const hh = requireHousehold(req, 'owner');
    const { id } = parse(z.object({ id: z.coerce.number().int() }), req.params);
    const r = db.prepare('UPDATE invites SET revoked=1 WHERE id=? AND household_id=?').run(id, hh);
    if (!r.changes) throw new HttpError(404, 'Invite not found');
    return { ok: true };
  });

  app.patch('/api/household/members/:userId', async (req) => {
    const hh = requireHousehold(req, 'owner');
    const { userId } = parse(z.object({ userId: z.coerce.number().int() }), req.params);
    const { role } = parse(z.object({ role: z.enum(['owner', 'member', 'viewer']) }), req.body);
    const cur = db.prepare('SELECT role FROM memberships WHERE user_id=? AND household_id=?').get(userId, hh) as { role: Role } | undefined;
    if (!cur) throw new HttpError(404, 'Member not found');
    if (cur.role === 'owner' && role !== 'owner' && ownerCount(hh) <= 1) throw new HttpError(400, 'A household needs at least one owner');
    db.prepare('UPDATE memberships SET role=? WHERE user_id=? AND household_id=?').run(role, userId, hh);
    return { ok: true };
  });

  /** Owners remove anyone; any member may remove themselves (leave). */
  app.delete('/api/household/members/:userId', async (req) => {
    const hh = requireHousehold(req);
    const ctx = req.ctx!;
    const { userId } = parse(z.object({ userId: z.coerce.number().int() }), req.params);
    if (userId !== ctx.user.id && ctx.role !== 'owner') throw new HttpError(403, 'Only household owners can do that');
    const cur = db.prepare('SELECT role FROM memberships WHERE user_id=? AND household_id=?').get(userId, hh) as { role: Role } | undefined;
    if (!cur) throw new HttpError(404, 'Member not found');
    if (cur.role === 'owner' && ownerCount(hh) <= 1) throw new HttpError(400, 'Transfer ownership or delete the household instead');
    db.prepare('DELETE FROM memberships WHERE user_id=? AND household_id=?').run(userId, hh);
    // Sessions pointing at this household fall back to another membership on their next request (see loadCtx).
    db.prepare('UPDATE sessions SET household_id=NULL WHERE user_id=? AND household_id=?').run(userId, hh);
    return { ok: true };
  });
}
