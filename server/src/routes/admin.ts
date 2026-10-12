import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';
import { HttpError, hashPassword, randomToken, requireAdmin } from '../auth.js';
import { createInvite, emailInvite, inviteEmailSchema } from './household.js';
import { parse } from '../util.js';

export default async function adminRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;

  app.get('/api/admin/overview', async (req) => {
    requireAdmin(req);
    const users = db.prepare(`SELECT u.id, u.email, u.name, u.is_admin, u.disabled, u.created_at,
      (SELECT group_concat(h.name || ' (' || m.role || ')', ', ') FROM memberships m JOIN households h ON h.id=m.household_id WHERE m.user_id=u.id) AS households
      FROM users u ORDER BY u.created_at`).all();
    const month = new Date().toISOString().slice(0, 7);
    const households = db.prepare(`SELECT h.id, h.name, h.receipt_quota, h.created_at,
      (SELECT COUNT(*) FROM memberships WHERE household_id=h.id) AS members,
      (SELECT COUNT(*) FROM items WHERE household_id=h.id) AS items,
      (SELECT COUNT(*) FROM mesh_nodes WHERE household_id=h.id) AS nodes,
      COALESCE((SELECT count FROM receipt_usage WHERE household_id=h.id AND month=?),0) AS receipts_this_month
      FROM households h ORDER BY h.created_at`).all(month);
    const invites = db.prepare(`SELECT id, note, email, emailed_at, created_at, expires_at FROM invites WHERE household_id IS NULL AND used_by IS NULL AND revoked=0 AND expires_at>?`).all(Date.now());
    return { users, households, invites };
  });

  /** Offline barcode mirror: sources, row counts, last refresh. */
  app.get('/api/admin/barcodes', async (req) => {
    requireAdmin(req);
    return { ...(deps.barcodes?.status() ?? { enabled: false, products: 0, sizeMb: 0, sources: [] }), running: deps.barcodes?.running() ?? false };
  });

  /** Starts a refresh in the background; `force` re-downloads even if the data is current. */
  app.post('/api/admin/barcodes/refresh', async (req) => {
    requireAdmin(req);
    const body = parse(z.object({ source: z.enum(['usda', 'off']).optional(), force: z.boolean().prefault(true) }), req.body ?? {});
    if (!deps.barcodes?.status().enabled) throw new HttpError(409, 'The barcode mirror is disabled on this instance (BARCODE_MIRROR=off)');
    if (deps.barcodes.running()) throw new HttpError(409, 'A refresh is already running');
    void deps.barcodes.refresh({ sources: body.source ? [body.source] : undefined, force: body.force });
    return { started: true };
  });

  /** Invite someone to start their own household. */
  app.post('/api/admin/invites', async (req) => {
    const ctx = requireAdmin(req);
    const { note, email } = parse(z.object({ note: z.string().max(100).optional(), email: inviteEmailSchema }), req.body);
    const inv = createInvite(deps, ctx.user.id, null, 'owner', note, email);
    return { ...inv, ...(email ? await emailInvite(deps, inv.id, ctx.user, email) : { emailed: false }) };
  });

  app.post('/api/admin/invites/:id/resend', async (req) => {
    const ctx = requireAdmin(req);
    const { id } = parse(z.object({ id: z.coerce.number().int() }), req.params);
    const { email } = parse(z.object({ email: inviteEmailSchema }), req.body ?? {});
    if (!db.prepare('SELECT 1 FROM invites WHERE id=? AND household_id IS NULL').get(id)) throw new HttpError(404, 'Invite not found');
    const r = await emailInvite(deps, id, ctx.user, email);
    if (!r.emailed) throw new HttpError(409, r.emailError ?? 'Couldn’t send');
    return r;
  });

  app.delete('/api/admin/invites/:id', async (req) => {
    requireAdmin(req);
    const { id } = parse(z.object({ id: z.coerce.number().int() }), req.params);
    db.prepare('UPDATE invites SET revoked=1 WHERE id=? AND household_id IS NULL').run(id);
    return { ok: true };
  });

  app.patch('/api/admin/users/:id', async (req) => {
    const ctx = requireAdmin(req);
    const { id } = parse(z.object({ id: z.coerce.number().int() }), req.params);
    const body = parse(z.object({ disabled: z.boolean().optional(), isAdmin: z.boolean().optional() }), req.body);
    if (id === ctx.user.id && (body.disabled || body.isAdmin === false)) throw new HttpError(400, "You can't disable or demote yourself");
    if (body.disabled !== undefined) {
      db.prepare('UPDATE users SET disabled=? WHERE id=?').run(body.disabled ? 1 : 0, id);
      if (body.disabled) db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
    }
    if (body.isAdmin !== undefined) db.prepare('UPDATE users SET is_admin=? WHERE id=?').run(body.isAdmin ? 1 : 0, id);
    return { ok: true };
  });

  app.post('/api/admin/users/:id/reset-password', async (req) => {
    requireAdmin(req);
    const { id } = parse(z.object({ id: z.coerce.number().int() }), req.params);
    const temp = randomToken(9);
    const r = db.prepare('UPDATE users SET pw_hash=? WHERE id=?').run(await hashPassword(temp), id);
    if (!r.changes) throw new HttpError(404, 'User not found');
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
    return { tempPassword: temp };
  });

  app.patch('/api/admin/households/:id', async (req) => {
    requireAdmin(req);
    const { id } = parse(z.object({ id: z.coerce.number().int() }), req.params);
    const { receiptQuota } = parse(z.object({ receiptQuota: z.number().int().min(0).max(10000) }), req.body);
    db.prepare('UPDATE households SET receipt_quota=? WHERE id=?').run(receiptQuota, id);
    return { ok: true };
  });
}
