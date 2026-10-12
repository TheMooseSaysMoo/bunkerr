import crypto from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppDeps } from '../app.js';
import { HttpError, hashPassword, validatePassword } from '../auth.js';
import { config } from '../config.js';
import { touchWrite } from '../db.js';
import { parse } from '../util.js';

/**
 * Account provisioning for an external family portal ("hub"). The hub verifies the
 * family member's Cloudflare Access identity and calls this server-to-server, so a family
 * member can make their Bunkerr account without an invite link.
 *
 * - Off unless HUB_TOKEN is set; LAN/tailnet only (never through the Cloudflare tunnel).
 * - Refuses on an instance that isn't active, so the hub can try the next URL instead of
 *   writing to a standby whose data the next sync would overwrite.
 * - Never touches an account that already exists: no password reset, no rename. Otherwise
 *   this endpoint would be an account-takeover primitive.
 */
function requireHub(req: FastifyRequest, deps: AppDeps) {
  if (!config.hubToken) throw new HttpError(404, 'Not found');
  if (req.headers['cf-connecting-ip'] || req.headers['cf-ray']) throw new HttpError(404, 'Not found');
  const got = Buffer.from(String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(config.hubToken);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) throw new HttpError(403, 'Forbidden');
  if (!deps.ha.isActive()) throw new HttpError(503, 'This instance is not active');
}

const emailSchema = z.email().max(200).transform((e) => e.trim().toLowerCase());

export default async function hubRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;
  const findUser = (email: string) =>
    db.prepare('SELECT id, email, name, disabled FROM users WHERE lower(email)=?').get(email) as
      { id: number; email: string; name: string; disabled: number } | undefined;

  app.get('/api/hub/accounts', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    requireHub(req, deps);
    const { email } = parse(z.object({ email: emailSchema }), req.query);
    const u = findUser(email);
    return u ? { exists: true, email: u.email, disabled: !!u.disabled } : { exists: false };
  });

  app.post('/api/hub/accounts', { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (req, reply) => {
    requireHub(req, deps);
    const body = parse(z.object({
      email: emailSchema,
      name: z.string().trim().min(1).max(60),
      password: z.string(),
    }), req.body);
    validatePassword(body.password);
    const existing = findUser(body.email);
    if (existing) return { outcome: 'already_exists', email: existing.email };
    const pwHash = await hashPassword(body.password);
    const created = db.transaction(() => {
      if (findUser(body.email)) return false; // two tabs racing
      const t = Date.now();
      const uid = Number(db.prepare('INSERT INTO users (email,name,pw_hash,created_at) VALUES (?,?,?,?)').run(body.email, body.name, pwHash, t).lastInsertRowid);
      // Same as a "new household" invite: they own a fresh household and can invite their own people.
      const hh = Number(db.prepare('INSERT INTO households (name,created_at) VALUES (?,?)').run(`${body.name}'s household`, t).lastInsertRowid);
      db.prepare(`INSERT INTO memberships (user_id,household_id,role,created_at) VALUES (?,?,'owner',?)`).run(uid, hh, t);
      touchWrite(db);
      return true;
    })();
    if (!created) return { outcome: 'already_exists', email: body.email };
    req.log.info({ email: body.email }, 'account created via hub');
    reply.status(201);
    return { outcome: 'created', email: body.email };
  });
}
