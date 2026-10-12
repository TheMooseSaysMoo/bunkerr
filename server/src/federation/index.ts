import { z } from 'zod';
import { touchWrite, type DB } from '../db.js';
import type { Ha } from '../ha.js';
import type { Notifier } from '../notify.js';
import type { IngestState } from '../mesh/ingest.js';
import { HttpError, randomToken, sha256 } from '../auth.js';
import { seal, unseal } from '../secrets.js';
import { householdSummary } from '../summary.js';
import { getSettings } from '../settings.js';
import { checkPeerUrl, parseLinkCode, peerFetch } from './url.js';
import { CHANNEL_RE, GATEWAY_RE, createRelay, type RelayPacket } from './relay.js';

/**
 * Linked households: a household here and a household on another Bunkerr server agree to a link
 * (a one-time code made by one owner, pasted by the other). Each side then decides what it
 * shares and fetches what the other shares every few minutes, keeping the last copy so it still
 * shows when the other server or the internet is down. The armory is never shared.
 *
 * Each side holds a random token for the other: the token we hand out is stored hashed, the one
 * we present is sealed with INTERNAL_SECRET (so the standby can use it after a failover).
 */

export const CODE_TTL_MS = 7 * 86400_000;
const PULL_EVERY_MS = 5 * 60_000;
/** A brand-new link may not be saved on the other side yet; don't treat a 401 as "unlinked" right away. */
const NEW_LINK_GRACE_MS = 2 * 60_000;

export const shareSchema = z.object({
  summary: z.boolean().default(true),
  inventory: z.boolean().default(false),
  power: z.boolean().default(false),
  mesh: z.boolean().default(false),
});
export type Share = z.infer<typeof shareSchema>;
/** A change to some of the switches. (Zod 4 fills in defaults even on .partial(), so no defaults here.) */
export const sharePatchSchema = z.object({ summary: z.boolean(), inventory: z.boolean(), power: z.boolean(), mesh: z.boolean() }).partial();

const str = (n: number) => z.string().max(n);
const num = z.number().nullable();
/** What a linked server sends. Validated before it's stored or shown. */
export const feedSchema = z.object({
  v: z.number(),
  household: str(80),
  generated_at: z.number(),
  shares: shareSchema,
  relay_channels: z.array(str(20)).max(20).default([]),
  summary: z.object({
    people: z.number(), foodDays: num, waterDays: num, waterGallons: z.number(),
    counts: z.array(z.object({ category: str(30), batches: z.number(), qty: z.number() })).max(50),
    expired: z.number(), soon: z.number(), lowStock: z.number(),
    power: z.object({ devices: z.number(), due: z.number() }),
    mesh: z.object({ total: z.number(), online: z.number() }),
  }).optional(),
  items: z.array(z.object({ name: str(200), category: str(30), qty: z.number(), unit: str(20), expires_on: str(10).nullable(), min_qty: num })).max(5000).optional(),
  power: z.array(z.object({
    name: str(80), kind: str(30), brand: str(60), model: str(80), capacity_wh: num, output_w: num, fuel: str(30), charge_pct: num,
    next_due_on: str(10).nullable(), next_task: str(80).nullable(),
  })).max(500).optional(),
  mesh: z.array(z.object({
    node_id: str(12), name: str(80), short_name: str(10).nullable(), site: str(60), hw_model: str(40).nullable(), role: str(30).nullable(),
    last_heard: num, online: z.boolean(), battery: num, ch_util: num, snr: num, hops_away: num,
  })).max(500).optional(),
});
export type Feed = z.infer<typeof feedSchema>;

export interface LinkRow {
  id: number; household_id: number; status: 'active' | 'ended'; peer_url: string; peer_household: string;
  in_token_hash: string; out_token_sealed: string; share: string; relay_channels: string;
  feed: string | null; feed_at: number | null; pull_at: number | null; pull_error: string | null; seen_at: number | null;
  created_by: number | null; created_at: number;
}

export const parseShare = (json: string): Share => {
  try { return shareSchema.parse(JSON.parse(json)); } catch { return shareSchema.parse({}); }
};
export const parseChannels = (s: string) => s.split(',').map((c) => c.trim()).filter(Boolean);

const cut = (s: string | null | undefined, n: number) => (s == null ? null : s.slice(0, n));

/** What this household shares over one link. Never armory, item locations, notes, serials or node positions. */
export function buildFeed(db: DB, hh: number, share: Share, relayChannels: string[]): Feed {
  const name = (db.prepare('SELECT name FROM households WHERE id=?').get(hh) as { name: string }).name;
  const feed: Feed = { v: 1, household: cut(name, 80)!, generated_at: Date.now(), shares: share, relay_channels: relayChannels };
  const s = getSettings(db, hh);
  if (share.summary) {
    const sum = householdSummary(db, hh);
    feed.summary = {
      people: s.people, foodDays: sum.foodDays, waterDays: sum.waterDays, waterGallons: sum.waterGallons,
      counts: sum.counts.map((c) => ({ ...c, category: cut(c.category, 30)! })),
      expired: sum.expired.length, soon: sum.soon.length, lowStock: sum.lowStock.length,
      power: { devices: sum.power.count, due: sum.power.due.length },
      mesh: { total: sum.mesh.total, online: sum.mesh.total - sum.mesh.offline.length - sum.mesh.pending },
    };
  }
  if (share.inventory) {
    feed.items = (db.prepare(`SELECT name, category, qty, unit, expires_on, min_qty FROM items WHERE household_id=?
      ORDER BY category, name COLLATE NOCASE, expires_on LIMIT 5000`).all(hh) as NonNullable<Feed['items']>)
      .map((i) => ({ ...i, name: cut(i.name, 200)!, category: cut(i.category, 30)!, unit: cut(i.unit, 20)! }));
  }
  if (share.power) {
    feed.power = (db.prepare(`SELECT e.name, e.kind, e.brand, e.model, e.capacity_wh, e.output_w, e.fuel, e.charge_pct,
        (SELECT next_due_on FROM equipment_tasks t WHERE t.equipment_id=e.id ORDER BY next_due_on LIMIT 1) AS next_due_on,
        (SELECT label FROM equipment_tasks t WHERE t.equipment_id=e.id ORDER BY next_due_on LIMIT 1) AS next_task
      FROM equipment e WHERE e.household_id=? ORDER BY e.name COLLATE NOCASE LIMIT 500`).all(hh) as NonNullable<Feed['power']>)
      .map((e) => ({ ...e, name: cut(e.name, 80)!, brand: cut(e.brand, 60)!, model: cut(e.model, 80)!, fuel: cut(e.fuel, 30)!, next_task: cut(e.next_task, 80) }));
  }
  if (share.mesh) {
    const offlineMs = s.meshOfflineMinutes * 60000;
    const rows = db.prepare(`SELECT node_id, label, long_name, short_name, site, hw_model, role, last_heard, battery, ch_util, snr, hops_away
      FROM mesh_nodes WHERE household_id=? ORDER BY site, label, long_name LIMIT 500`).all(hh) as
      { node_id: string; label: string; long_name: string | null; short_name: string | null; site: string; hw_model: string | null; role: string | null; last_heard: number | null; battery: number | null; ch_util: number | null; snr: number | null; hops_away: number | null }[];
    feed.mesh = rows.map((n) => ({
      node_id: n.node_id, name: cut(n.label || n.long_name || n.node_id, 80)!, short_name: cut(n.short_name, 10), site: cut(n.site, 60)!,
      hw_model: cut(n.hw_model, 40), role: cut(n.role, 30), last_heard: n.last_heard, online: n.last_heard != null && Date.now() - n.last_heard < offlineMs,
      battery: n.battery, ch_util: n.ch_util, snr: n.snr, hops_away: n.hops_away,
    }));
  }
  return feed;
}

export interface FederationOptions {
  enabled: boolean;
  publicUrl: string;
  allowPrivate: boolean;
  mqttRoot: string;
  mqttTopics: string[];
}

type Log = { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void };

const peerError = (r: { status: number; json: unknown; text: string }) => {
  const msg = (r.json as { error?: unknown } | null)?.error;
  return `the other server said ${r.status}${typeof msg === 'string' ? `: ${msg.slice(0, 200)}` : ''}`;
};

/** "msh/US/MyTown/#" → "msh/US/MyTown". Null when the filter doesn't pin down one root. */
export function rootFromTopics(topics: string[]): string | null {
  const t = topics[0]?.replace(/\/#$/, '');
  if (!t || /[+#]/.test(t)) return null;
  const root = t.includes('/2/') ? t.slice(0, t.indexOf('/2/')) : t;
  return root.split('/').length >= 2 ? root : null;
}

export function createFederation(db: DB, ha: Ha, notifier: Notifier, mesh: IngestState, opts: FederationOptions) {
  const getLink = (id: number) => db.prepare('SELECT * FROM links WHERE id=?').get(id) as LinkRow | undefined;
  const hhName = (hh: number) => (db.prepare('SELECT name FROM households WHERE id=?').get(hh) as { name: string } | undefined)?.name ?? '';
  const host = (url: string) => { try { return new URL(url).host; } catch { return url; } };
  const outToken = (l: LinkRow) => {
    const t = unseal(l.out_token_sealed);
    if (!t) throw new Error('can’t read the saved link token (INTERNAL_SECRET changed?). Remove the link and link again');
    return t;
  };
  const localRoot = () => opts.mqttRoot || rootFromTopics(opts.mqttTopics) || mesh.root;

  let relayCache: { at: number; links: { id: number; channels: string[] }[] } | null = null;
  const relayLinks = () => {
    if (!relayCache || Date.now() - relayCache.at > 30_000) {
      const rows = db.prepare(`SELECT id, relay_channels FROM links WHERE status='active' AND relay_channels<>''`).all() as { id: number; relay_channels: string }[];
      relayCache = { at: Date.now(), links: rows.map((r) => ({ id: r.id, channels: parseChannels(r.relay_channels) })) };
    }
    return relayCache.links;
  };

  const relay = createRelay({
    links: relayLinks,
    async send(id, packets) {
      const l = getLink(id);
      if (!l || l.status !== 'active') return {};
      const r = await peerFetch(`${l.peer_url}/api/federation/mesh`, { method: 'POST', token: outToken(l), body: { packets }, timeoutMs: 10000 });
      if (!r.ok) throw new Error(peerError(r));
      return (r.json ?? {}) as { refused?: string[] };
    },
    publish: (topic, payload) => mesh.publish?.(topic, payload) ?? false,
    root: localRoot,
    isActive: () => ha.isActive(),
  });
  mesh.onRaw = (topic, payload) => relay.onLocal(topic, payload);

  const notify = (hh: number, title: string, lines: string[]) =>
    notifier.send(hh, { title, lines, url: `${opts.publicUrl}/#/settings` }).catch(() => {});

  function endLink(l: LinkRow) {
    db.prepare(`UPDATE links SET status='ended', feed=NULL, feed_at=NULL, relay_channels='' WHERE id=?`).run(l.id);
    relayCache = null;
    relay.forget(l.id);
    void notify(l.household_id, `Link ended: ${l.peer_household || host(l.peer_url)}`, [`${l.peer_household} (${host(l.peer_url)}) removed the link with ${hhName(l.household_id)}.`, 'Nothing is shared either way any more.']);
  }

  async function pull(id: number) {
    const l = getLink(id);
    if (!l || l.status !== 'active') return;
    try {
      const r = await peerFetch(`${l.peer_url}/api/federation/feed`, { token: outToken(l) });
      if (r.status === 401 || r.status === 403) {
        if (Date.now() - l.created_at > NEW_LINK_GRACE_MS) { endLink(l); return; }
        throw new Error('not recognized by the other server yet');
      }
      if (!r.ok) throw new Error(peerError(r));
      const parsed = feedSchema.safeParse(r.json);
      if (!parsed.success) throw new Error('the other server sent data this version doesn’t understand (update both servers)');
      db.prepare('UPDATE links SET feed=?, feed_at=?, pull_at=?, pull_error=NULL, peer_household=? WHERE id=?')
        .run(JSON.stringify(parsed.data), parsed.data.generated_at, Date.now(), parsed.data.household, l.id);
    } catch (e) {
      const err = e as Error;
      const msg = err.name === 'TimeoutError' ? 'timed out reaching the other server' : err.message.startsWith('fetch failed') ? `can’t reach ${host(l.peer_url)}` : err.message;
      db.prepare('UPDATE links SET pull_at=?, pull_error=? WHERE id=?').run(Date.now(), msg.slice(0, 300), l.id);
    }
  }

  async function pullAll() {
    const ids = (db.prepare(`SELECT id FROM links WHERE status='active'`).all() as { id: number }[]).map((r) => r.id);
    for (const id of ids) await pull(id);
  }

  const timers: NodeJS.Timeout[] = [];

  return {
    enabled: opts.enabled,
    publicUrl: opts.publicUrl,
    relay,
    localRoot,
    getLink,
    pull,
    pullAll,
    invalidateRelay() { relayCache = null; },

    /** One-time code for another server's owner to paste. */
    createCode(hh: number, userId: number) {
      const code = randomToken(24);
      const t = Date.now();
      const id = Number(db.prepare('INSERT INTO link_codes (household_id,code_hash,created_by,created_at,expires_at) VALUES (?,?,?,?,?)')
        .run(hh, sha256(code), userId, t, t + CODE_TTL_MS).lastInsertRowid);
      return { id, url: `${opts.publicUrl}/#/link/${code}`, expires_at: t + CODE_TTL_MS };
    },

    /** This side pastes the other server's code. */
    async connect(hh: number, userId: number, input: string): Promise<number> {
      const { url, code } = parseLinkCode(input);
      const base = await checkPeerUrl(url, opts.allowPrivate);
      if (base === opts.publicUrl) throw new HttpError(400, 'That code is from this server. Link codes connect households on two different Bunkerr servers');
      try { await checkPeerUrl(opts.publicUrl, opts.allowPrivate); } catch (e) {
        throw new HttpError(400, `The other server couldn’t reach this one: PUBLIC_URL is ${opts.publicUrl}. ${(e as Error).message}`);
      }
      const inToken = randomToken(32);
      let r;
      try { r = await peerFetch(`${base}/api/federation/accept`, { method: 'POST', body: { code, url: opts.publicUrl, household: hhName(hh), token: inToken } }); }
      catch (e) { throw new HttpError(502, `Couldn’t reach ${host(base)}: ${(e as Error).name === 'TimeoutError' ? 'timed out' : (e as Error).message}`); }
      if (!r.ok) throw new HttpError(r.status === 410 || r.status === 400 ? r.status : 502, `${host(base)}: ${(r.json as { error?: string } | null)?.error ?? `HTTP ${r.status}`}`);
      const got = z.object({ token: z.string().min(32).max(200), household: z.string().max(80) }).safeParse(r.json);
      if (!got.success) throw new HttpError(502, `${host(base)} answered, but not like a Bunkerr server`);
      const id = Number(db.prepare(`INSERT INTO links (household_id,peer_url,peer_household,in_token_hash,out_token_sealed,share,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)`)
        .run(hh, base, got.data.household, sha256(inToken), seal(got.data.token), JSON.stringify(shareSchema.parse({})), userId, Date.now()).lastInsertRowid);
      touchWrite(db);
      pull(id).catch(() => {});
      return id;
    },

    /** The other server presents our code. */
    async accept(body: unknown) {
      const b = z.object({
        code: z.string().min(20).max(80),
        url: z.string().max(300),
        household: z.string().trim().min(1).max(80),
        token: z.string().min(32).max(200),
      }).safeParse(body);
      if (!b.success) throw new HttpError(400, 'Malformed link request');
      let base: string;
      try { base = await checkPeerUrl(b.data.url, opts.allowPrivate); } catch (e) {
        throw new HttpError(400, `This server can’t reach yours (${b.data.url}): ${(e as Error).message}. Set PUBLIC_URL to your https address`);
      }
      const token = randomToken(32);
      const t = Date.now();
      const linked = db.transaction(() => {
        const c = db.prepare('SELECT id, household_id, created_by FROM link_codes WHERE code_hash=? AND used_at IS NULL AND expires_at>?').get(sha256(b.data.code), t) as
          { id: number; household_id: number; created_by: number | null } | undefined;
        if (!c) return null;
        db.prepare('UPDATE link_codes SET used_at=? WHERE id=?').run(t, c.id);
        const id = Number(db.prepare(`INSERT INTO links (household_id,peer_url,peer_household,in_token_hash,out_token_sealed,share,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)`)
          .run(c.household_id, base, b.data.household, sha256(token), seal(b.data.token), JSON.stringify(shareSchema.parse({})), c.created_by, t).lastInsertRowid);
        touchWrite(db);
        return { id, hh: c.household_id };
      })();
      if (!linked) throw new HttpError(410, 'That link code is invalid, expired or already used. Ask for a new one');
      void notify(linked.hh, `Linked with ${b.data.household}`, [
        `${b.data.household} (${host(base)}) is now linked with ${hhName(linked.hh)}.`,
        'They see only what you share: the readiness summary to start. Change it in Settings → linked households.',
      ]);
      // Give the other side a moment to save the link before fetching from it.
      setTimeout(() => pull(linked.id).catch(() => {}), 5000).unref?.();
      return { token, household: hhName(linked.hh) };
    },

    /** Resolves the bearer token another server presents. */
    authPeer(authorization: string | undefined): LinkRow {
      const token = String(authorization ?? '').replace(/^Bearer\s+/i, '');
      const l = token ? db.prepare(`SELECT * FROM links WHERE in_token_hash=?`).get(sha256(token)) as LinkRow | undefined : undefined;
      if (!l || l.status !== 'active') throw new HttpError(401, 'Unknown link');
      if (!l.seen_at || Date.now() - l.seen_at > 60_000) db.prepare('UPDATE links SET seen_at=? WHERE id=?').run(Date.now(), l.id);
      return l;
    },

    feedFor: (l: LinkRow) => buildFeed(db, l.household_id, parseShare(l.share), parseChannels(l.relay_channels)),

    /** The other server unlinked. */
    peerUnlinked(l: LinkRow) { endLink(l); },

    /** Packets from the other server's mesh. */
    meshIn(l: LinkRow, body: unknown) {
      const b = z.object({ packets: z.array(z.object({ c: z.string().regex(CHANNEL_RE), g: z.string().regex(GATEWAY_RE), d: z.string().max(2048) })).max(200) }).safeParse(body);
      if (!b.success) throw new HttpError(400, 'Malformed packets');
      return relay.onPeer(l.id, parseChannels(l.relay_channels), b.data.packets as RelayPacket[]);
    },

    /** We unlink: tell the other server (best effort) and forget the link. */
    async unlink(l: LinkRow) {
      if (l.status === 'active') {
        try { await peerFetch(`${l.peer_url}/api/federation/unlink`, { method: 'POST', token: outToken(l), body: {}, timeoutMs: 5000 }); } catch { /* their next fetch gets a 401 and ends it there */ }
      }
      db.prepare('DELETE FROM links WHERE id=?').run(l.id);
      relayCache = null;
      relay.forget(l.id);
      touchWrite(db);
    },

    start(log: Log) {
      if (!opts.enabled) return;
      const guard = (fn: () => Promise<void>) => () => { if (ha.isActive()) fn().catch((e) => log.warn({ err: e }, 'linked households job failed')); };
      timers.push(setInterval(guard(pullAll), PULL_EVERY_MS));
      timers.push(setInterval(guard(() => relay.flush()), 1000));
      timers.push(setTimeout(guard(pullAll), 20_000));
    },
    stop() { timers.forEach((t) => clearTimeout(t)); },
  };
}

export type Federation = ReturnType<typeof createFederation>;
