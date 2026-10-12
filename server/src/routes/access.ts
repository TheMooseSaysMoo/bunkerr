import crypto from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';
import { HttpError, createSession, hashPassword, randomToken, requireAdmin, sha256, validatePassword } from '../auth.js';
import { config } from '../config.js';
import { touchWrite, type DB } from '../db.js';
import { meResponse } from './account.js';
import { parse } from '../util.js';
import { renderAlert } from '../mailer.js';
import { seal, unseal } from '../secrets.js';

/**
 * "Request access" on the login page, for people outside the family hub.
 *
 * Bunkerr can't send email, so the requester gets a private status link (kept on their
 * device too). Admins see it in Settings, by email if they opted in, and on the household's alert
 * channel. A webhook router that supports actions can offer approve/reject (e.g. ✅/❌ reactions):
 * each POSTs a signed URL scoped to one request, one decision and an expiry, so no secret
 * ever sits in the Discord message. Once approved, the status link lets them choose a password,
 * and they get their own household.
 */

const DECISION_TTL = 14 * 86400000;
const MAX_PENDING = 30;

interface RequestRow { id: number; email: string; name: string; note: string; status: string; created_at: number; decided_at: number | null; decided_by: string | null }

/** HMAC key kept in the database, so it travels to the standby and signed links survive a failover. */
function hmacKey(db: DB): string {
  const row = db.prepare(`SELECT value FROM meta WHERE key='access_hmac_key'`).get() as { value: string } | undefined;
  if (row) return row.value;
  const k = randomToken(32);
  db.prepare(`INSERT INTO meta(key,value) VALUES('access_hmac_key',?) ON CONFLICT(key) DO NOTHING`).run(k);
  return (db.prepare(`SELECT value FROM meta WHERE key='access_hmac_key'`).get() as { value: string }).value;
}

export function signDecision(db: DB, id: number, action: 'approve' | 'reject', exp: number) {
  return crypto.createHmac('sha256', hmacKey(db)).update(`${id}:${action}:${exp}`).digest('base64url');
}

export function decisionUrl(db: DB, id: number, action: 'approve' | 'reject', now = Date.now()) {
  const exp = now + DECISION_TTL;
  return `${config.publicUrl}/api/access-requests/${id}/${action}?exp=${exp}&sig=${signDecision(db, id, action, exp)}`;
}

const maskEmail = (e: string) => e.replace(/^(.)(.*)(@.*)$/, (_m, a: string, b: string, d: string) => a + '•'.repeat(Math.min(b.length, 6)) + d);

/** The admin who should hear about requests: the first admin's first household. */
function adminHousehold(db: DB): number | null {
  const r = db.prepare(`SELECT m.household_id AS hh FROM users u JOIN memberships m ON m.user_id=u.id
    WHERE u.is_admin=1 AND u.disabled=0 ORDER BY u.id, m.created_at LIMIT 1`).get() as { hh: number } | undefined;
  return r?.hh ?? null;
}

export default async function accessRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db, mailer } = deps;
  const statusLink = (token: string) => `${config.publicUrl}/#/request/${token}`;
  /** Best effort: email is a convenience here, never a reason for a request to fail. */
  const mail = (to: string, subject: string, title: string, lines: string[], url?: string) => {
    if (!mailer.ready()) return;
    const body = renderAlert({ title, lines, url });
    mailer.send({ to, subject, ...body })
      .catch((e) => app.log.warn({ err: (e as Error).message }, 'access request email failed'));
  };
  const byToken = (token: string) => db.prepare('SELECT * FROM access_requests WHERE token_hash=?').get(sha256(token)) as RequestRow | undefined;

  function decide(id: number, action: 'approve' | 'reject', by: string): RequestRow {
    const r = db.prepare('SELECT * FROM access_requests WHERE id=?').get(id) as RequestRow | undefined;
    if (!r) throw new HttpError(404, 'No such request');
    if (r.status !== 'pending') throw new HttpError(409, `Already ${r.status}`);
    db.prepare(`UPDATE access_requests SET status=?, decided_at=?, decided_by=? WHERE id=? AND status='pending'`)
      .run(action === 'approve' ? 'approved' : 'rejected', Date.now(), by, id);
    touchWrite(db);
    const token = unseal((db.prepare('SELECT token_sealed FROM access_requests WHERE id=?').get(id) as { token_sealed: string | null }).token_sealed);
    if (action === 'approve') {
      mail(r.email, '[Bunkerr] You’re approved', 'You’re approved', [`Hi ${r.name},`, '', 'Your Bunkerr access request was approved.', token ? 'Open your link to choose a password and set up your household:' : 'Open the link you saved when you asked, to choose a password.'], token ? statusLink(token) : undefined);
    } else {
      mail(r.email, '[Bunkerr] About your access request', 'Access request', [`Hi ${r.name},`, '', 'Sorry, your Bunkerr access request wasn’t approved.']);
    }
    return { ...r, status: action === 'approve' ? 'approved' : 'rejected' };
  }

  // ---------------- public ----------------
  app.post('/api/access-requests', { config: { rateLimit: { max: 3, timeWindow: '1 hour' } } }, async (req) => {
    if (!deps.ha.isActive()) throw new HttpError(503, 'Try again in a few minutes');
    const body = parse(z.object({
      email: z.email().max(200).transform((e) => e.trim().toLowerCase()),
      name: z.string().trim().min(1, 'name is required').max(60),
      note: z.string().trim().max(500).prefault(''),
      website: z.string().max(200).optional(), // honeypot: people never see this field
    }), req.body);
    const token = randomToken(24);
    // Bots fill every field. Pretend it worked so they don't adapt.
    if (body.website) return { token, status: 'pending' };

    const existing = db.prepare(`SELECT 1 FROM access_requests WHERE email=? AND status IN ('pending','approved')`).get(body.email);
    const hasAccount = db.prepare('SELECT 1 FROM users WHERE lower(email)=?').get(body.email);
    if (existing || hasAccount) {
      // Same shape either way, so this can't be used to find out who has an account.
      throw new HttpError(409, 'There is already an account or a request for that email. If it is yours, open your status link or log in.');
    }
    const pending = (db.prepare(`SELECT COUNT(*) AS n FROM access_requests WHERE status='pending'`).get() as { n: number }).n;
    if (pending >= MAX_PENDING) throw new HttpError(429, 'Too many requests are waiting. Try again later.');

    // The link is also kept sealed, so the approval email (if email is set up) can include it.
    const id = Number(db.prepare(`INSERT INTO access_requests (email,name,note,token_hash,token_sealed,ip,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(body.email, body.name, body.note, sha256(token), seal(token), String(req.headers['cf-connecting-ip'] ?? req.ip), Date.now()).lastInsertRowid);
    touchWrite(db);
    mail(body.email, '[Bunkerr] We got your access request', 'Access request received',
      [`Hi ${body.name},`, '', 'Thanks for asking. You’ll get another email once it’s been looked at.', 'You can also check on it any time with your private link:'], statusLink(token));
    const admins = db.prepare('SELECT email FROM users WHERE is_admin=1 AND disabled=0 AND email_access_requests=1').all() as { email: string }[];
    for (const a of admins) {
      mail(a.email, `[Bunkerr] Access request: ${body.name}`, `Access request: ${body.name}`,
        [`name   ${body.name}`, `email  ${body.email}`, ...(body.note ? [`note   ${body.note.replace(/\s+/g, ' ').slice(0, 300)}`] : []), '', 'Approve or reject in Settings → instance admin.'], `${config.publicUrl}/#/settings`);
    }

    const hh = adminHousehold(db);
    if (hh != null) {
      const approve = decisionUrl(db, id, 'approve');
      const reject = decisionUrl(db, id, 'reject');
      void deps.notifier.send(hh, {
        title: `Access request: ${body.name}`,
        lines: [
          `name   ${body.name}`,
          `email  ${body.email}`,
          ...(body.note ? [`note   ${body.note.replace(/\s+/g, ' ').slice(0, 300)}`] : []),
          '',
          'React ✅ to approve or ❌ to reject.',
          'Or: Settings → instance admin → access requests.',
        ],
        url: `${config.publicUrl}/#/settings`,
        actions: `http, Approve, ${approve}, method=POST; http, Reject, ${reject}, method=POST`,
      }).catch((e) => req.log.warn({ err: e }, 'access request notification failed'));
    }
    return { token, status: 'pending' };
  });

  app.get('/api/access-requests/status/:token', async (req) => {
    const { token } = parse(z.object({ token: z.string().min(10).max(100) }), req.params);
    const r = byToken(token);
    if (!r) throw new HttpError(404, 'Request not found');
    return { status: r.status, name: r.name, email: maskEmail(r.email), createdAt: r.created_at, decidedAt: r.decided_at };
  });

  app.post('/api/access-requests/status/:token/register', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (req, reply) => {
    if (!deps.ha.isActive()) throw new HttpError(503, 'Try again in a few minutes');
    const { token } = parse(z.object({ token: z.string().min(10).max(100) }), req.params);
    const body = parse(z.object({ password: z.string(), householdName: z.string().trim().max(60).optional() }), req.body);
    validatePassword(body.password);
    const r = byToken(token);
    if (!r) throw new HttpError(404, 'Request not found');
    if (r.status !== 'approved') throw new HttpError(409, r.status === 'completed' ? 'Your account is already set up. Log in.' : 'This request has not been approved');
    if (db.prepare('SELECT 1 FROM users WHERE lower(email)=?').get(r.email)) throw new HttpError(409, 'An account with that email already exists. Log in.');
    const pwHash = await hashPassword(body.password);
    const { uid, hh } = db.transaction(() => {
      const t = Date.now();
      const uid = Number(db.prepare('INSERT INTO users (email,name,pw_hash,created_at) VALUES (?,?,?,?)').run(r.email, r.name, pwHash, t).lastInsertRowid);
      const hh = Number(db.prepare('INSERT INTO households (name,created_at) VALUES (?,?)').run(body.householdName || `${r.name}'s household`, t).lastInsertRowid);
      db.prepare(`INSERT INTO memberships (user_id,household_id,role,created_at) VALUES (?,?,'owner',?)`).run(uid, hh, t);
      const done = db.prepare(`UPDATE access_requests SET status='completed', user_id=? WHERE id=? AND status='approved'`).run(uid, r.id);
      if (done.changes !== 1) throw new HttpError(409, 'Your account is already set up. Log in.');
      touchWrite(db);
      return { uid, hh };
    })();
    createSession(db, reply, uid, hh);
    return meResponse(deps, uid, hh);
  });

  // Signed decision links, performed by a webhook router when the admin approves or rejects there.
  app.post('/api/access-requests/:id/:action', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const { id, action } = parse(z.object({ id: z.coerce.number().int().positive(), action: z.enum(['approve', 'reject']) }), req.params);
    const { exp, sig } = parse(z.object({ exp: z.coerce.number().int(), sig: z.string().min(20).max(100) }), req.query);
    const want = Buffer.from(signDecision(db, id, action, exp));
    const got = Buffer.from(sig);
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) throw new HttpError(403, 'Bad signature');
    if (Date.now() > exp) throw new HttpError(410, 'This link has expired. Decide in Settings → instance admin.');
    if (!deps.ha.isActive()) throw new HttpError(503, 'This instance is not active');
    const r = decide(id, action, 'discord');
    return { ok: true, id, status: r.status };
  });

  // ---------------- admin ----------------
  app.get('/api/admin/access-requests', async (req) => {
    requireAdmin(req);
    return db.prepare(`SELECT id,email,name,note,status,created_at,decided_at,decided_by FROM access_requests
      ORDER BY status='pending' DESC, created_at DESC LIMIT 100`).all();
  });

  app.post('/api/admin/access-requests/:id/:action', async (req) => {
    const ctx = requireAdmin(req);
    const { id, action } = parse(z.object({ id: z.coerce.number().int().positive(), action: z.enum(['approve', 'reject']) }), req.params);
    return decide(id, action, ctx.user.email);
  });

  app.delete('/api/admin/access-requests/:id', async (req) => {
    requireAdmin(req);
    const { id } = parse(z.object({ id: z.coerce.number().int().positive() }), req.params);
    db.prepare(`DELETE FROM access_requests WHERE id=? AND status<>'completed'`).run(id);
    return { ok: true };
  });
}
