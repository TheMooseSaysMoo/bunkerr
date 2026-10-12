/**
 * Mesh relay between linked servers. Meshtastic gateways publish every packet they hear on a
 * channel to `<root>/2/e/<channel>/<gateway id>` (a protobuf ServiceEnvelope), and gateways with
 * downlink on take packets published there by *other* gateways and transmit them over LoRa.
 * The relay copies those envelopes for the chosen channel names to the linked server over the
 * existing https link, and that server publishes them under its own root. Neither broker has
 * to be reachable from the internet.
 *
 * Packets are de-duplicated by sender + packet id in both directions, so a packet that came from
 * the other mesh and was heard again by another local gateway is never sent back.
 */

export interface RelayPacket { c: string; g: string; d: string } // channel name, gateway id, base64 envelope
export interface RelayStats { sent: number; received: number; dropped: number; lastSentAt: number | null; lastReceivedAt: number | null; error: string | null }

export const CHANNEL_RE = /^[^/#+\s,]{1,20}$/;
export const GATEWAY_RE = /^![0-9a-f]{8}$/;
const TOPIC_RE = /^(.+)\/2\/e\/([^/]+)\/(![0-9a-f]{8})$/;
const SEEN_TTL_MS = 3600_000;
const QUEUE_MAX = 300;
const BATCH_MAX = 100;
const STALE_MS = 5 * 60_000;
export const MAX_ENVELOPE_BYTES = 1024;

/** Reads the sender and packet id out of a ServiceEnvelope (field 1: MeshPacket; from = 1, id = 6, both fixed32). */
export function packetKey(buf: Buffer): string | null {
  const field = (b: Buffer, want: number, wantType: number): Buffer | number | null => {
    let i = 0;
    const varint = () => {
      let v = 0, shift = 0;
      for (;;) {
        if (i >= b.length || shift > 63) throw new Error('truncated');
        const byte = b[i++];
        v += (byte & 0x7f) * 2 ** shift;
        if (byte < 0x80) return v;
        shift += 7;
      }
    };
    while (i < b.length) {
      const tag = varint();
      const no = Math.floor(tag / 8), type = tag & 7;
      let val: Buffer | number;
      if (type === 0) val = varint();
      else if (type === 1) { if (i + 8 > b.length) throw new Error('truncated'); val = 0; i += 8; }
      else if (type === 2) { const len = varint(); if (i + len > b.length) throw new Error('truncated'); val = b.subarray(i, i + len); i += len; }
      else if (type === 5) { if (i + 4 > b.length) throw new Error('truncated'); val = b.readUInt32LE(i); i += 4; }
      else throw new Error('bad wire type');
      if (no === want && type === wantType) return val;
    }
    return null;
  };
  try {
    const pkt = field(buf, 1, 2);
    if (!Buffer.isBuffer(pkt)) return null;
    const from = field(pkt, 1, 5), id = field(pkt, 6, 5);
    if (typeof from !== 'number' || typeof id !== 'number' || !id) return null;
    return `${from.toString(16)}:${id.toString(16)}`;
  } catch {
    return null;
  }
}

export interface RelayDeps {
  /** Active links and the channel names each relays (cached by the caller). */
  links: () => { id: number; channels: string[] }[];
  send: (linkId: number, packets: RelayPacket[]) => Promise<{ refused?: string[] }>;
  /** Publishes to the local broker; false when it isn't connected. */
  publish: (topic: string, payload: Buffer) => boolean;
  root: () => string | null;
  isActive: () => boolean;
}

export function createRelay(deps: RelayDeps) {
  const seen = new Map<string, number>();
  const queues = new Map<number, { items: { p: RelayPacket; at: number }[]; busy: boolean; failures: number; retryAt: number }>();
  const stats = new Map<number, RelayStats>();
  const stat = (id: number) => {
    let s = stats.get(id);
    if (!s) stats.set(id, (s = { sent: 0, received: 0, dropped: 0, lastSentAt: null, lastReceivedAt: null, error: null }));
    return s;
  };

  /** True the first time a packet is seen within the TTL. */
  const firstSighting = (key: string, at: number) => {
    const prev = seen.get(key);
    if (prev != null && at - prev < SEEN_TTL_MS) return false;
    seen.delete(key);
    seen.set(key, at);
    // Oldest first (re-sighted keys were moved to the end above).
    if (seen.size > 20000) for (const k of seen.keys()) { seen.delete(k); if (seen.size <= 15000) break; }
    return true;
  };

  return {
    /** A packet from the local broker. */
    onLocal(topic: string, payload: Buffer, at = Date.now()) {
      if (!deps.isActive()) return;
      const m = topic.match(TOPIC_RE);
      if (!m || payload.length > MAX_ENVELOPE_BYTES) return;
      const [, , channel, gateway] = m;
      const targets = deps.links().filter((l) => l.channels.includes(channel));
      if (!targets.length) return;
      const key = packetKey(payload);
      if (!key || !firstSighting(key, at)) return;
      const p: RelayPacket = { c: channel, g: gateway, d: payload.toString('base64') };
      for (const l of targets) {
        let q = queues.get(l.id);
        if (!q) queues.set(l.id, (q = { items: [], busy: false, failures: 0, retryAt: 0 }));
        q.items.push({ p, at });
        if (q.items.length > QUEUE_MAX) { q.items.shift(); stat(l.id).dropped++; }
      }
    },

    /** Packets the linked server sent us. Only channels this side also relays are published. */
    onPeer(linkId: number, channels: string[], packets: RelayPacket[], at = Date.now()) {
      const root = deps.root();
      let published = 0;
      const refused = new Set<string>();
      for (const p of packets) {
        if (!channels.includes(p.c)) { refused.add(p.c); continue; }
        if (!root) continue;
        const buf = Buffer.from(p.d, 'base64');
        if (!buf.length || buf.length > MAX_ENVELOPE_BYTES) continue;
        const key = packetKey(buf);
        if (!key || !firstSighting(key, at)) continue;
        if (deps.publish(`${root}/2/e/${p.c}/${p.g}`, buf)) published++;
      }
      const s = stat(linkId);
      s.received += published;
      if (published) s.lastReceivedAt = at;
      return { published, refused: [...refused], noRoot: !root };
    },

    /** Sends queued packets; call about once a second. */
    async flush(at = Date.now()) {
      const jobs: Promise<void>[] = [];
      for (const [id, q] of queues) {
        if (q.busy || !q.items.length || at < q.retryAt) continue;
        const fresh = q.items.filter((x) => at - x.at < STALE_MS);
        stat(id).dropped += q.items.length - fresh.length;
        q.items = fresh;
        const batch = q.items.splice(0, BATCH_MAX);
        if (!batch.length) continue;
        q.busy = true;
        jobs.push(deps.send(id, batch.map((x) => x.p)).then((r) => {
          const s = stat(id);
          s.sent += batch.length; s.lastSentAt = Date.now();
          s.error = r.refused?.length ? `the other server doesn’t relay: ${r.refused.join(', ')}` : null;
          q.failures = 0;
        }, (e: Error) => {
          q.items.unshift(...batch);
          q.items.splice(QUEUE_MAX);
          q.failures++;
          q.retryAt = at + Math.min(60_000, 1000 * 2 ** q.failures);
          stat(id).error = e.message;
        }).finally(() => { q.busy = false; }));
      }
      await Promise.all(jobs);
    },

    stats: (linkId: number): RelayStats => ({ ...stat(linkId) }),
    forget(linkId: number) { queues.delete(linkId); stats.delete(linkId); },
  };
}

export type Relay = ReturnType<typeof createRelay>;
