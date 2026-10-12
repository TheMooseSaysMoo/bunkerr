import crypto from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { DB } from './db.js';
import { config } from './config.js';

export type Role = 'owner' | 'member' | 'viewer';
export const SESSION_COOKIE = 'bunkerr_sid';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

export interface UserRow { id: number; email: string; name: string; pw_hash: string; is_admin: number; disabled: number }

/** Request context resolved from the session cookie. household is NEVER taken from request params. */
export interface Ctx {
  user: { id: number; email: string; name: string; isAdmin: boolean };
  sessionId: string;
  householdId: number | null;
  role: Role | null;
}

declare module 'fastify' {
  interface FastifyRequest { ctx: Ctx | null }
}

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

export const hashPassword = (pw: string) => hash(pw, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
export const verifyPassword = (h: string, pw: string) => verify(h, pw).catch(() => false);

export function validatePassword(pw: unknown): string {
  if (typeof pw !== 'string' || pw.length < 10) throw new HttpError(400, 'Password must be at least 10 characters');
  if (pw.length > 200) throw new HttpError(400, 'Password too long');
  return pw;
}

export function createSession(db: DB, reply: FastifyReply, userId: number, householdId: number | null) {
  const token = randomToken();
  const t = Date.now();
  db.prepare('INSERT INTO sessions (id,user_id,household_id,created_at,expires_at) VALUES (?,?,?,?,?)')
    .run(sha256(token), userId, householdId, t, t + SESSION_TTL_MS);
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/', httpOnly: true, sameSite: 'strict', secure: config.cookieSecure, maxAge: SESSION_TTL_MS / 1000,
  });
}

export function firstHousehold(db: DB, userId: number): number | null {
  const r = db.prepare(`SELECT household_id FROM memberships WHERE user_id=? ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'member' THEN 1 ELSE 2 END, created_at LIMIT 1`)
    .get(userId) as { household_id: number } | undefined;
  return r?.household_id ?? null;
}

/** Resolve ctx from cookie. Re-validates membership on every request so removed members lose access immediately. */
export function loadCtx(db: DB, req: FastifyRequest): Ctx | null {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return null;
  const sid = sha256(token);
  const s = db.prepare(`SELECT s.id, s.household_id, s.expires_at, u.id AS uid, u.email, u.name, u.is_admin, u.disabled
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`).get(sid) as
    { id: string; household_id: number | null; expires_at: number; uid: number; email: string; name: string; is_admin: number; disabled: number } | undefined;
  if (!s || s.expires_at < Date.now() || s.disabled) return null;

  let householdId = s.household_id;
  let role: Role | null = null;
  if (householdId != null) {
    const m = db.prepare('SELECT role FROM memberships WHERE user_id=? AND household_id=?').get(s.uid, householdId) as { role: Role } | undefined;
    role = m?.role ?? null;
  }
  if (role == null) {
    householdId = firstHousehold(db, s.uid);
    if (householdId != null) role = (db.prepare('SELECT role FROM memberships WHERE user_id=? AND household_id=?').get(s.uid, householdId) as { role: Role }).role;
    db.prepare('UPDATE sessions SET household_id=? WHERE id=?').run(householdId, sid);
  }
  // Rolling expiry, refreshed at most once a day.
  if (s.expires_at - Date.now() < SESSION_TTL_MS - 24 * 3600 * 1000) {
    db.prepare('UPDATE sessions SET expires_at=? WHERE id=?').run(Date.now() + SESSION_TTL_MS, sid);
  }
  return {
    user: { id: s.uid, email: s.email, name: s.name, isAdmin: !!s.is_admin },
    sessionId: sid, householdId, role,
  };
}

const RANK: Record<Role, number> = { viewer: 0, member: 1, owner: 2 };

export function requireUser(req: FastifyRequest): Ctx {
  if (!req.ctx) throw new HttpError(401, 'Not logged in');
  return req.ctx;
}

/** Returns the active household id, enforcing a minimum role. Use for every tenant-scoped query. */
export function requireHousehold(req: FastifyRequest, min: Role = 'viewer'): number {
  const ctx = requireUser(req);
  if (ctx.householdId == null || ctx.role == null) throw new HttpError(409, 'No household selected');
  if (RANK[ctx.role] < RANK[min]) throw new HttpError(403, min === 'owner' ? 'Only household owners can do that' : 'Read-only access');
  return ctx.householdId;
}

export function requireAdmin(req: FastifyRequest): Ctx {
  const ctx = requireUser(req);
  if (!ctx.user.isAdmin) throw new HttpError(403, 'Admins only');
  return ctx;
}

export const canWrite = (role: Role | null) => role === 'owner' || role === 'member';
