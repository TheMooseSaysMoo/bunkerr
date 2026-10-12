import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppDeps } from '../app.js';
import { HttpError, requireHousehold } from '../auth.js';
import { config } from '../config.js';
import { touchWrite } from '../db.js';
import { feedSchema, parseChannels, parseShare, sharePatchSchema, type Feed, type LinkRow } from '../federation/index.js';
import { CHANNEL_RE } from '../federation/relay.js';
import { idParam, parse } from '../util.js';

const host = (url: string) => { try { return new URL(url).host; } catch { return url; } };

/** A link as this household's members see it: what we share, and what they share with us. */
export function linkView(deps: AppDeps, l: LinkRow, withFeed = true) {
  const channels = parseChannels(l.relay_channels);
  let feed: Feed | null = null;
  if (l.feed) { const p = feedSchema.safeParse(JSON.parse(l.feed)); feed = p.success ? p.data : null; }
  return {
    id: l.id, status: l.status, peer_url: l.peer_url, peer_host: host(l.peer_url), peer_household: l.peer_household,
    share: parseShare(l.share), relay_channels: channels, relay: channels.length ? deps.federation.relay.stats(l.id) : null,
    feed_at: l.feed_at, pull_at: l.pull_at, pull_error: l.pull_error, seen_at: l.seen_at, created_at: l.created_at,
    feed: withFeed ? feed : null,
    summary: feed?.summary ?? null,
  };
}

export default async function linkRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db, federation: fed, ha } = deps;
  const on = () => { if (!fed.enabled) throw new HttpError(404, 'Linked households are turned off on this server (FEDERATION=off)'); };
  const own = (hh: number, id: number) => {
    const l = db.prepare('SELECT * FROM links WHERE id=? AND household_id=?').get(id, hh) as LinkRow | undefined;
    if (!l) throw new HttpError(404, 'Link not found');
    return l;
  };

  // ---------------- this household's members ----------------
  app.get('/api/links', async (req) => {
    const hh = requireHousehold(req);
    const owner = req.ctx!.role === 'owner';
    const rows = db.prepare('SELECT * FROM links WHERE household_id=? ORDER BY peer_household COLLATE NOCASE').all(hh) as LinkRow[];
    const codes = owner ? db.prepare('SELECT id, created_at, expires_at FROM link_codes WHERE household_id=? AND used_at IS NULL AND expires_at>? ORDER BY created_at DESC').all(hh, Date.now()) : [];
    return {
      enabled: fed.enabled,
      links: rows.map((l) => linkView(deps, l)),
      codes,
      relay: { available: !!config.mqttUrl, root: fed.localRoot(), canEdit: req.ctx!.user.isAdmin },
    };
  });

  app.post('/api/links/codes', { config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (req) => {
    const hh = requireHousehold(req, 'owner');
    on();
    return fed.createCode(hh, req.ctx!.user.id);
  });

  app.delete('/api/links/codes/:id', async (req) => {
    const hh = requireHousehold(req, 'owner');
    const { id } = parse(idParam, req.params);
    db.prepare('DELETE FROM link_codes WHERE id=? AND household_id=? AND used_at IS NULL').run(id, hh);
    return { ok: true };
  });

  app.post('/api/links/connect', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req) => {
    const hh = requireHousehold(req, 'owner');
    on();
    const { code } = parse(z.object({ code: z.string().trim().min(10).max(500) }), req.body);
    const id = await fed.connect(hh, req.ctx!.user.id, code);
    return linkView(deps, fed.getLink(id)!);
  });

  app.patch('/api/links/:id', async (req) => {
    const hh = requireHousehold(req, 'owner');
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({
      share: sharePatchSchema.optional(),
      relay_channels: z.array(z.string().trim().regex(CHANNEL_RE, 'channel names are 1–20 characters, without / # + or spaces')).max(10).optional(),
    }), req.body);
    const l = own(hh, id);
    if (b.share) db.prepare('UPDATE links SET share=? WHERE id=?').run(JSON.stringify({ ...parseShare(l.share), ...b.share }), id);
    if (b.relay_channels) {
      // The broker belongs to the whole server, not one household.
      if (!req.ctx!.user.isAdmin) throw new HttpError(403, 'Only the instance admin can relay mesh channels');
      if (l.status !== 'active') throw new HttpError(409, 'This link has ended');
      db.prepare('UPDATE links SET relay_channels=? WHERE id=?').run([...new Set(b.relay_channels)].join(','), id);
      fed.invalidateRelay();
    }
    touchWrite(db);
    return linkView(deps, fed.getLink(id)!);
  });

  app.post('/api/links/:id/refresh', { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } }, async (req) => {
    const hh = requireHousehold(req);
    const { id } = parse(idParam, req.params);
    own(hh, id);
    if (!ha.isActive()) throw new HttpError(409, 'This instance is not active');
    await fed.pull(id);
    return linkView(deps, fed.getLink(id)!);
  });

  app.delete('/api/links/:id', async (req) => {
    const hh = requireHousehold(req, 'owner');
    const { id } = parse(idParam, req.params);
    await fed.unlink(own(hh, id));
    return { ok: true };
  });

  // ---------------- other Bunkerr servers (bearer token, no cookies) ----------------
  const peer = (req: FastifyRequest) => {
    on();
    if (!ha.isActive()) throw new HttpError(503, 'This instance is not active');
    return fed.authPeer(req.headers.authorization);
  };

  app.post('/api/federation/accept', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req) => {
    on();
    if (!ha.isActive()) throw new HttpError(503, 'This instance is not active');
    return fed.accept(req.body);
  });

  app.get('/api/federation/feed', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => fed.feedFor(peer(req)));

  app.post('/api/federation/unlink', async (req) => {
    fed.peerUnlinked(peer(req));
    return { ok: true };
  });

  app.post('/api/federation/mesh', { bodyLimit: 512 * 1024, config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req) => fed.meshIn(peer(req), req.body));
}
