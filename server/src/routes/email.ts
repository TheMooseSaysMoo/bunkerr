import { z } from 'zod';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AppDeps } from '../app.js';
import { HttpError, requireAdmin, requireUser } from '../auth.js';
import { config } from '../config.js';
import { touchWrite } from '../db.js';
import { renderAlert, saveSmtp, smtpInput, smtpPublic, unsubscribeSig, type EmailKind } from '../mailer.js';
import { hmacEqual } from '../secrets.js';
import { parse } from '../util.js';

/** SMTP errors can echo the server's reply; keep them short and never include the config. */
const smtpError = (e: unknown) => String((e as Error)?.message ?? e).replace(/\s+/g, ' ').slice(0, 300);

const page = (reply: FastifyReply, title: string, body: string) => reply.type('text/html; charset=utf-8').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="margin:0;padding:24px 16px;background:#0a0e0b;color:#dbe7dd;font-family:ui-monospace,Menlo,Consolas,monospace">
<div style="max-width:520px;margin:0 auto;border:1px solid #263629;border-radius:8px;padding:18px;background:#121a14">${body}</div></body></html>`);

export default async function emailRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db, mailer } = deps;

  // ---------------- admin: SMTP server ----------------
  app.get('/api/admin/smtp', async (req) => { requireAdmin(req); return smtpPublic(db); });

  app.put('/api/admin/smtp', async (req) => {
    requireAdmin(req);
    const body = parse(smtpInput, req.body);
    if (body.enabled && (!body.host || !body.from_email)) throw new HttpError(400, 'Host and from address are required to turn email on');
    saveSmtp(db, body);
    touchWrite(db);
    return smtpPublic(db);
  });

  app.post('/api/admin/smtp/test', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => {
    const ctx = requireAdmin(req);
    const { to } = parse(z.object({ to: z.email().max(200).optional() }), req.body ?? {});
    const body = renderAlert({ title: 'Bunkerr test email', lines: ['$ echo "comms check"', 'comms check', '', `from ${config.nodeName}`], url: config.publicUrl });
    const dest = to ?? ctx.user.email;
    try {
      const r = await mailer.send({ to: dest, subject: '[Bunkerr] Test email', ...body });
      // Logged so "it never arrived" can be traced with the provider by queue / message id.
      req.log.info({ to: dest, smtp: r }, 'test email accepted by SMTP server');
      return { ok: true, to: dest, ...r, host: smtpPublic(db).host };
    } catch (e) {
      req.log.warn({ to: dest, err: smtpError(e) }, 'test email failed');
      throw new HttpError(502, `SMTP: ${smtpError(e)}`);
    }
  });

  // ---------------- me: subscriptions ----------------
  app.get('/api/me/email', async (req) => {
    const ctx = requireUser(req);
    const rows = db.prepare(`SELECT h.id AS household_id, h.name, m.role, COALESCE(s.digest,0) AS digest, COALESCE(s.alerts,0) AS alerts
      FROM memberships m JOIN households h ON h.id=m.household_id
      LEFT JOIN email_subscriptions s ON s.user_id=m.user_id AND s.household_id=m.household_id
      WHERE m.user_id=? ORDER BY h.name`).all(ctx.user.id) as { household_id: number; name: string; role: string; digest: number; alerts: number }[];
    const u = db.prepare('SELECT email, email_access_requests FROM users WHERE id=?').get(ctx.user.id) as { email: string; email_access_requests: number };
    return {
      available: mailer.ready(),
      email: u.email,
      households: rows.map((r) => ({ ...r, digest: !!r.digest, alerts: !!r.alerts })),
      accessRequests: ctx.user.isAdmin ? !!u.email_access_requests : null,
    };
  });

  app.put('/api/me/email/households/:id', async (req) => {
    const ctx = requireUser(req);
    const { id } = parse(z.object({ id: z.coerce.number().int().positive() }), req.params);
    // Either field may be sent alone; the other keeps its value (two quick taps can't undo each other).
    const b = parse(z.object({ digest: z.boolean().optional(), alerts: z.boolean().optional() }), req.body);
    if (!db.prepare('SELECT 1 FROM memberships WHERE user_id=? AND household_id=?').get(ctx.user.id, id)) throw new HttpError(404, 'Household not found');
    const cur = db.prepare('SELECT digest, alerts FROM email_subscriptions WHERE user_id=? AND household_id=?').get(ctx.user.id, id) as { digest: number; alerts: number } | undefined;
    const digest = b.digest ?? !!cur?.digest, alerts = b.alerts ?? !!cur?.alerts;
    db.prepare(`INSERT INTO email_subscriptions (user_id,household_id,digest,alerts,created_at) VALUES (?,?,?,?,?)
      ON CONFLICT(user_id,household_id) DO UPDATE SET digest=excluded.digest, alerts=excluded.alerts`).run(ctx.user.id, id, digest ? 1 : 0, alerts ? 1 : 0, Date.now());
    touchWrite(db);
    return { ok: true };
  });

  app.put('/api/me/email/access-requests', async (req) => {
    const ctx = requireAdmin(req);
    const { on } = parse(z.object({ on: z.boolean() }), req.body);
    db.prepare('UPDATE users SET email_access_requests=? WHERE id=?').run(on ? 1 : 0, ctx.user.id);
    touchWrite(db);
    return { ok: true };
  });

  app.post('/api/me/email/test', { config: { rateLimit: { max: 3, timeWindow: '5 minutes' } } }, async (req) => {
    const ctx = requireUser(req);
    if (!mailer.ready()) throw new HttpError(409, 'Email isn’t set up on this instance yet');
    const body = renderAlert({ title: 'Bunkerr test email', lines: ['Email alerts are working.', '', 'You’ll get the ones you ticked in Settings → email alerts.'], url: config.publicUrl });
    try {
      const r = await mailer.send({ to: ctx.user.email, subject: '[Bunkerr] Test email', ...body });
      req.log.info({ to: ctx.user.email, smtp: r }, 'test email accepted by SMTP server');
      return { ok: true, to: ctx.user.email, ...r };
    } catch (e) { throw new HttpError(502, `Couldn’t send: ${smtpError(e)}`); }
  });

  // ---------------- unsubscribe (signed, no login) ----------------
  const unsubQuery = z.object({ u: z.coerce.number().int().positive(), h: z.coerce.number().int().positive(), k: z.enum(['digest', 'alerts']), sig: z.string().min(20).max(100) });
  const checkSig = (q: z.infer<typeof unsubQuery>) => hmacEqual(q.sig, unsubscribeSig(db, q.u, q.h, q.k as EmailKind));

  // GET only shows a button: mail scanners follow links, and a GET must not unsubscribe anyone.
  app.get('/api/email/unsubscribe', async (req, reply) => {
    const q = unsubQuery.safeParse(req.query);
    if (!q.success || !checkSig(q.data)) return page(reply.status(400), 'Bunkerr', '<p>This unsubscribe link isn’t valid.</p>');
    const hh = db.prepare('SELECT name FROM households WHERE id=?').get(q.data.h) as { name: string } | undefined;
    const what = q.data.k === 'digest' ? 'the daily digest' : 'urgent alerts';
    return page(reply, 'Unsubscribe — Bunkerr', `<p style="color:#5ee38a;font-weight:700">$ unsubscribe</p>
<p>Stop emailing you ${what}${hh ? ` for <strong>${hh.name.replace(/[<>&]/g, '')}</strong>` : ''}?</p>
<form method="post"><button style="background:#5ee38a;color:#04140a;border:0;border-radius:6px;padding:10px 16px;font:inherit;font-weight:700;cursor:pointer">unsubscribe</button></form>
<p style="color:#8aa08f;font-size:13px">You can turn it back on in Settings → email alerts.</p>`);
  });

  // POST does it: the button above, and one-click unsubscribe from mail apps (RFC 8058).
  app.post('/api/email/unsubscribe', async (req, reply) => {
    const q = unsubQuery.safeParse(req.query);
    if (!q.success || !checkSig(q.data)) return page(reply.status(400), 'Bunkerr', '<p>This unsubscribe link isn’t valid.</p>');
    db.prepare(`UPDATE email_subscriptions SET ${q.data.k === 'digest' ? 'digest' : 'alerts'}=0 WHERE user_id=? AND household_id=?`).run(q.data.u, q.data.h);
    touchWrite(db);
    return page(reply, 'Unsubscribed — Bunkerr', `<p style="color:#5ee38a;font-weight:700">$ done</p><p>You won’t get ${q.data.k === 'digest' ? 'the daily digest' : 'urgent alerts'} by email any more.</p><p><a style="color:#5ee38a" href="${config.publicUrl}/#/settings">Settings</a></p>`);
  });
}
