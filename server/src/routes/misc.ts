import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppDeps } from '../app.js';
import { HttpError, requireHousehold, requireUser } from '../auth.js';
import { config } from '../config.js';
import { getSettings, publicSettings, saveSettings, settingsSchema } from '../settings.js';
import { householdSummary } from '../summary.js';
import { armoryVisibleTo } from './account.js';
import { rmDbFiles } from '../ha.js';
import { parse } from '../util.js';

function requireInternal(req: FastifyRequest) {
  if (!config.internalSecret) throw new HttpError(404, 'Not found');
  // Internal endpoints are for the Tailscale path only, never through the Cloudflare tunnel.
  if (req.headers['cf-connecting-ip'] || req.headers['cf-ray']) throw new HttpError(404, 'Not found');
  const got = Buffer.from(String(req.headers['x-bunkerr-secret'] ?? ''));
  const want = Buffer.from(config.internalSecret);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) throw new HttpError(403, 'Forbidden');
}

export default async function miscRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db, ha } = deps;

  app.get('/healthz', async () => {
    db.prepare('SELECT 1').get();
    const s = ha.status();
    return { ok: true, node: s.node, role: s.role, active: s.active, promoted: s.promoted };
  });

  // ---- settings ----
  app.get('/api/settings', async (req) => {
    const hh = requireHousehold(req);
    return publicSettings(getSettings(db, hh), req.ctx!.role === 'owner');
  });

  app.put('/api/settings', async (req) => {
    const hh = requireHousehold(req, 'owner');
    const next = parse(settingsSchema, req.body);
    // The webhook router is the instance owner's infrastructure — only instance admins may point a household at it.
    if (!req.ctx!.user.isAdmin) {
      const cur = getSettings(db, hh);
      next.notify.router = cur.notify.router;
      next.notify.routerSource = cur.notify.routerSource;
    }
    try { new Intl.DateTimeFormat('en-US', { timeZone: next.timezone }); } catch { throw new HttpError(400, 'Unknown timezone'); }
    if (next.notify.discordWebhook && !/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//.test(next.notify.discordWebhook)) {
      throw new HttpError(400, 'Discord webhook must look like https://discord.com/api/webhooks/…');
    }
    if (next.notify.ntfyServer && !/^https?:\/\//.test(next.notify.ntfyServer)) throw new HttpError(400, 'ntfy server must be a URL');
    saveSettings(db, hh, next);
    return next;
  });

  app.post('/api/settings/test-notify', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => {
    const hh = requireHousehold(req, 'owner');
    const r = await deps.notifier.send(hh, { title: 'Bunkerr test notification', lines: ['$ echo "comms check"', 'comms check', '', `from ${config.nodeName}`], url: config.publicUrl });
    if (!r.sent.length && !r.errors.length) throw new HttpError(400, 'No notification channel is enabled and configured');
    return r;
  });

  // ---- dashboard ----
  app.get('/api/dashboard', async (req) => {
    const hh = requireHousehold(req);
    const { settings, armory, ...sum } = householdSummary(db, hh);
    const showArmory = armoryVisibleTo(settings, req.ctx!.role!);
    return { ...sum, people: settings.people, armory: showArmory ? armory : null };
  });

  // ---- docs (markdown files shipped in /docs) ----
  const docFiles = () => fs.existsSync(config.docsDir) ? fs.readdirSync(config.docsDir).filter((f) => f.endsWith('.md')).sort() : [];
  app.get('/api/docs', async (req) => {
    requireUser(req);
    return docFiles().map((f) => {
      const first = fs.readFileSync(path.join(config.docsDir, f), 'utf8').split('\n').find((l) => l.startsWith('# '));
      return { slug: f.replace(/\.md$/, ''), title: first ? first.slice(2).trim() : f };
    });
  });
  app.get('/api/docs/:slug', async (req) => {
    requireUser(req);
    const { slug } = parse(z.object({ slug: z.string().regex(/^[a-z0-9-]+$/) }), req.params);
    if (!docFiles().includes(`${slug}.md`)) throw new HttpError(404, 'Doc not found');
    return { slug, markdown: fs.readFileSync(path.join(config.docsDir, `${slug}.md`), 'utf8') };
  });

  // ---- instance status (status line) ----
  app.get('/api/instance', async (req) => {
    const ctx = requireUser(req);
    const s = ha.status();
    return ctx.user.isAdmin ? s : { node: s.node, active: s.active, role: s.role };
  });

  // ---- internal: failover (Tailscale only, shared secret) ----
  app.get('/api/internal/snapshot', async (req, reply) => {
    requireInternal(req);
    if (!ha.isActive()) throw new HttpError(409, 'This instance is not active; refusing to hand out a stale snapshot');
    const tmp = path.join(config.dataDir, `snapshot-${Date.now()}.db`);
    await ha.snapshotTo(tmp);
    const buf = fs.readFileSync(tmp);
    rmDbFiles(tmp);
    reply.header('content-type', 'application/octet-stream');
    return buf;
  });

  app.post('/api/internal/restore', { bodyLimit: 1024 * 1024 * 1024 }, async (req) => {
    requireInternal(req);
    const { force } = parse(z.object({ force: z.coerce.boolean().default(false) }), req.query);
    if (ha.isActive() && !force) throw new HttpError(409, 'Refusing to overwrite an active instance (demote the other side first, or ?force=1)');
    if (!Buffer.isBuffer(req.body)) throw new HttpError(400, 'Send the snapshot as application/octet-stream');
    const tmp = path.join(config.dataDir, `restore-${Date.now()}.db`);
    fs.writeFileSync(tmp, req.body);
    try { await ha.restoreFrom(tmp); } finally { rmDbFiles(tmp); }
    return { ok: true, bytes: req.body.length };
  });

  app.post('/api/internal/promote', async (req) => {
    requireInternal(req);
    ha.promote();
    return ha.status();
  });

  app.post('/api/internal/demote', async (req) => {
    requireInternal(req);
    ha.demote();
    return ha.status();
  });
}
