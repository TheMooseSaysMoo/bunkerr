import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeHa, login, makeApp, seedUser } from './helpers.js';
import { isPrivateAddress, checkPeerUrl, parseLinkCode } from '../src/federation/url.js';
import { createRelay, packetKey, type RelayPacket } from '../src/federation/relay.js';
import { rootFromTopics } from '../src/federation/index.js';

const freePort = () => new Promise<number>((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
});

/** A Meshtastic ServiceEnvelope: packet{from, to, encrypted, id}, channel_id, gateway_id. */
function envelope(from: number, id: number, channel = 'Family', gw = '!0000abcd') {
  const fixed = (no: number, v: number) => { const b = Buffer.alloc(5); b[0] = (no << 3) | 5; b.writeUInt32LE(v >>> 0, 1); return b; };
  const bytes = (no: number, v: Buffer) => Buffer.concat([Buffer.from([(no << 3) | 2, v.length]), v]);
  const pkt = Buffer.concat([fixed(1, from), fixed(2, 0xffffffff), bytes(5, Buffer.from([1, 2, 3, 4])), fixed(6, id)]);
  return Buffer.concat([bytes(1, pkt), bytes(2, Buffer.from(channel)), bytes(3, Buffer.from(gw))]);
}

type Server = Awaited<ReturnType<typeof makeApp>> & { url: string };
const open: Server[] = [];
afterEach(async () => { await Promise.all(open.splice(0).map((s) => s.app.close())); });

async function server(opts: Parameters<typeof makeApp>[0] = {}): Promise<Server> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const s = await makeApp({ ...opts, federation: { publicUrl: url, allowPrivate: true, ...opts.federation } });
  await s.app.listen({ port, host: '127.0.0.1' });
  const srv = { ...s, url };
  open.push(srv);
  return srv;
}

/** Two servers, an owner on each, linked from A's code. */
async function linked() {
  const a = await server();
  const b = await server();
  const alice = await seedUser(a.db, 'alice@example.com', { household: 'Alpha', admin: true });
  const bob = await seedUser(b.db, 'bob@example.com', { household: 'Bravo', admin: true });
  const ca = await login(a.app, 'alice@example.com');
  const cb = await login(b.app, 'bob@example.com');
  const code = await ca.post('/api/links/codes', {});
  expect(code.status).toBe(200);
  expect(code.json.url).toMatch(new RegExp(`^${a.url}/#/link/[A-Za-z0-9_-]{30,}$`));
  const conn = await cb.post('/api/links/connect', { code: code.json.url });
  expect(conn.status, conn.res.body).toBe(200);
  const linkA = (a.db.prepare('SELECT id FROM links').get() as { id: number }).id;
  const linkB = conn.json.id as number;
  return { a, b, alice, bob, ca, cb, linkA, linkB, code: code.json.url as string };
}

describe('linked households', () => {
  it('links two servers with a one-time code; each side shares only what it turns on', async () => {
    const { a, b, alice, ca, cb, linkA, linkB, code } = await linked();
    a.db.prepare(`INSERT INTO items (household_id,name,category,qty,unit,location,notes,expires_on,kcal_per_unit,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(alice.hh, 'Black beans', 'food', 12, 'can', 'basement safe', 'behind the furnace', '2029-03-01', 385, Date.now(), Date.now());
    a.db.prepare(`INSERT INTO firearms (household_id,make,model,caliber,serial,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).run(alice.hh, 'Glock', '19', '9mm', 'ABC123', Date.now(), Date.now());

    // The owner who made the code hears about the link.
    expect(a.sent.some((s) => s.householdId === alice.hh && s.m.title === 'Linked with Bravo')).toBe(true);
    expect((await cb.post('/api/links/connect', { code })).status).toBe(410); // one use only

    // Summary is shared by default; inventory isn't.
    await b.federation.pull(linkB);
    let view = (await cb.get('/api/links')).json.links[0];
    expect(view).toMatchObject({ status: 'active', peer_household: 'Alpha', share: { summary: true, inventory: false, power: false, mesh: false } });
    expect(view.feed.summary.counts).toEqual([{ category: 'food', batches: 1, qty: 12 }]);
    expect(view.feed.items).toBeUndefined();

    // Alice shares inventory: names and dates only, never locations, notes or the armory.
    expect((await ca.patch(`/api/links/${linkA}`, { share: { power: true } })).json.share).toEqual({ summary: true, inventory: false, power: true, mesh: false });
    // One switch at a time leaves the others alone.
    expect((await ca.patch(`/api/links/${linkA}`, { share: { inventory: true } })).json.share).toEqual({ summary: true, inventory: true, power: true, mesh: false });
    await ca.patch(`/api/links/${linkA}`, { share: { power: false } });
    view = (await cb.post(`/api/links/${linkB}/refresh`, {})).json;
    expect(view.feed.items).toEqual([{ name: 'Black beans', category: 'food', qty: 12, unit: 'can', expires_on: '2029-03-01', min_qty: null }]);
    const raw = String((b.db.prepare('SELECT feed FROM links').get() as { feed: string }).feed);
    for (const secret of ['basement', 'furnace', 'Glock', 'ABC123', '9mm']) expect(raw).not.toContain(secret);

    // The dashboard lists it without the full feed.
    const dash = (await cb.get('/api/dashboard')).json;
    expect(dash.linked).toHaveLength(1);
    expect(dash.linked[0]).toMatchObject({ peer_household: 'Alpha', summary: { people: 2 } });
    expect(dash.linked[0].feed).toBeUndefined();
    expect((await cb.get('/api/me')).json.links).toBe(1);

    // Bob unlinks: Alice's side ends too and drops what it had from Bob.
    await a.federation.pull(linkA);
    expect((a.db.prepare('SELECT feed FROM links').get() as { feed: string | null }).feed).not.toBeNull();
    expect((await cb.del(`/api/links/${linkB}`)).status).toBe(200);
    expect(b.db.prepare('SELECT COUNT(*) AS n FROM links').get()).toEqual({ n: 0 });
    expect(a.db.prepare('SELECT status, feed FROM links').get()).toEqual({ status: 'ended', feed: null });
    expect(a.sent.some((s) => s.m.title === 'Link ended: Bravo')).toBe(true);
    expect((await ca.patch(`/api/links/${linkA}`, { relay_channels: ['Family'] })).status).toBe(409);
  });

  it('ends a link when the other server no longer recognizes it', async () => {
    const { a, b, linkA } = await linked();
    b.db.prepare('DELETE FROM links').run(); // e.g. restored from an old backup
    a.db.prepare('UPDATE links SET created_at=?').run(Date.now() - 3600_000);
    await a.federation.pull(linkA);
    expect((a.db.prepare('SELECT status FROM links').get() as { status: string }).status).toBe('ended');
  });

  it('keeps the last copy and shows the error when the other server is down', async () => {
    const { b, linkB, a } = await linked();
    await b.federation.pull(linkB);
    await a.app.close();
    open.splice(open.indexOf(a), 1);
    await b.federation.pull(linkB);
    const row = b.db.prepare('SELECT feed, pull_error FROM links').get() as { feed: string | null; pull_error: string | null };
    expect(row.feed).not.toBeNull();
    expect(row.pull_error).toMatch(/can’t reach|timed out|ECONNREFUSED/);
  });

  it('only owners link or change sharing; viewers can look', async () => {
    const { a, alice, linkA } = await linked();
    const t = Date.now();
    for (const [email, role] of [['mem@example.com', 'member'], ['view@example.com', 'viewer']] as const) {
      const u = await seedUser(a.db, email);
      a.db.prepare('INSERT INTO memberships (user_id,household_id,role,created_at) VALUES (?,?,?,?)').run(u.uid, alice.hh, role, t);
      const c = await login(a.app, email);
      await c.post('/api/households/switch', { householdId: alice.hh });
      expect((await c.get('/api/links')).json.links).toHaveLength(1);
      expect((await c.post('/api/links/codes', {})).status).toBe(403);
      expect((await c.patch(`/api/links/${linkA}`, { share: { inventory: true } })).status).toBe(403);
      expect((await c.del(`/api/links/${linkA}`)).status).toBe(403);
      expect((await c.get('/api/links')).json.codes).toEqual([]);
    }
    // Another household on the same server can't see or touch it.
    const other = await seedUser(a.db, 'other@example.com');
    const co = await login(a.app, 'other@example.com');
    expect(other.hh).not.toBe(alice.hh);
    expect((await co.get('/api/links')).json.links).toEqual([]);
    expect((await co.patch(`/api/links/${linkA}`, { share: { inventory: true } })).status).toBe(404);
  });

  it('mesh relay needs the instance admin, and channel names are checked', async () => {
    const { a, alice, linkA } = await linked();
    const owner = await seedUser(a.db, 'owner2@example.com');
    a.db.prepare(`INSERT INTO memberships (user_id,household_id,role,created_at) VALUES (?,?,'owner',?)`).run(owner.uid, alice.hh, Date.now());
    const c = await login(a.app, 'owner2@example.com');
    await c.post('/api/households/switch', { householdId: alice.hh });
    expect((await c.patch(`/api/links/${linkA}`, { relay_channels: ['Family'] })).status).toBe(403);
    const ca = await login(a.app, 'alice@example.com');
    expect((await ca.patch(`/api/links/${linkA}`, { relay_channels: ['bad/name'] })).status).toBe(400);
    expect((await ca.patch(`/api/links/${linkA}`, { relay_channels: ['Family', 'Family'] })).json.relay_channels).toEqual(['Family']);
  });

  it('relays a shared mesh channel between the two brokers, without echoes', async () => {
    const { a, b, ca, cb, linkA, linkB } = await linked();
    const published: { srv: string; topic: string; payload: Buffer }[] = [];
    a.mesh.publish = (topic, payload) => { published.push({ srv: 'a', topic, payload }); return true; };
    b.mesh.publish = (topic, payload) => { published.push({ srv: 'b', topic, payload }); return true; };
    a.mesh.root = 'msh/US/Alpha';
    b.mesh.root = 'msh/US/Bravo';
    await ca.patch(`/api/links/${linkA}`, { relay_channels: ['Family'] });

    // B hasn't turned it on: packets are refused and A shows why.
    a.mesh.onRaw!('msh/US/Alpha/2/e/Family/!0000aaaa', envelope(0x11, 1));
    await a.federation.relay.flush();
    expect(published).toEqual([]);
    expect(a.federation.relay.stats(linkA).error).toMatch(/doesn’t relay: Family/);

    await cb.patch(`/api/links/${linkB}`, { relay_channels: ['Family'] });
    // The same packet heard by two of A's gateways goes over once; other channels stay home.
    a.mesh.onRaw!('msh/US/Alpha/2/e/Family/!0000aaaa', envelope(0x11, 2));
    a.mesh.onRaw!('msh/US/Alpha/2/e/Family/!0000bbbb', envelope(0x11, 2, 'Family', '!0000bbbb'));
    a.mesh.onRaw!('msh/US/Alpha/2/e/LongFast/!0000aaaa', envelope(0x11, 3, 'LongFast'));
    await a.federation.relay.flush();
    expect(published.map((p) => [p.srv, p.topic])).toEqual([['b', 'msh/US/Bravo/2/e/Family/!0000aaaa']]);
    expect(packetKey(published[0].payload)).toBe('11:2');

    // B's broker echoes it back to B's own subscription, and B's gateways re-uplink it: never sent back to A.
    b.mesh.onRaw!('msh/US/Bravo/2/e/Family/!0000aaaa', published[0].payload);
    b.mesh.onRaw!('msh/US/Bravo/2/e/Family/!0000cccc', envelope(0x11, 2, 'Family', '!0000cccc'));
    await b.federation.relay.flush();
    expect(published).toHaveLength(1);

    // B's own traffic reaches A.
    b.mesh.onRaw!('msh/US/Bravo/2/e/Family/!0000cccc', envelope(0x22, 9, 'Family', '!0000cccc'));
    await b.federation.relay.flush();
    expect(published.map((p) => [p.srv, p.topic])).toContainEqual(['a', 'msh/US/Alpha/2/e/Family/!0000cccc']);
    expect((await cb.get('/api/links')).json.links[0].relay).toMatchObject({ sent: 1, received: 1, error: null });
  });

  it('refuses unknown tokens, and everything on an inactive instance', async () => {
    const a = await server();
    for (const [method, url] of [['GET', '/api/federation/feed'], ['POST', '/api/federation/unlink'], ['POST', '/api/federation/mesh']] as const) {
      const r = await a.app.inject({ method, url, headers: { authorization: 'Bearer nope-nope-nope-nope-nope-nope-nope-nope' }, payload: method === 'POST' ? {} : undefined });
      expect(r.statusCode).toBe(401);
    }
    const s = await makeApp({ ha: { ...fakeHa(), isActive: () => false } });
    expect((await s.app.inject({ method: 'POST', url: '/api/federation/accept', payload: {} })).statusCode).toBe(503);
    const off = await makeApp({ federation: { enabled: false } });
    expect((await off.app.inject({ method: 'GET', url: '/api/federation/feed' })).statusCode).toBe(404);
  });
});

describe('link addresses', () => {
  it('spots private addresses', () => {
    for (const ip of ['10.1.2.3', '127.0.0.1', '192.168.1.10', '172.20.0.5', '100.101.102.103', '169.254.1.1', '0.0.0.0', '::1', 'fd7a:115c::1', 'fe80::1', '::ffff:192.168.0.1']) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['1.1.1.1', '172.32.0.1', '100.128.0.1', '2606:4700::1111']) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('only talks to public https servers unless private links are allowed', async () => {
    await expect(checkPeerUrl('http://bunkerr.example.com', false)).rejects.toThrow(/isn’t https/);
    await expect(checkPeerUrl('https://127.0.0.1:8787', false)).rejects.toThrow(/private address/);
    await expect(checkPeerUrl('https://user:pw@example.com', false)).rejects.toThrow(/username/);
    await expect(checkPeerUrl('http://192.168.1.5:8787/', true)).resolves.toBe('http://192.168.1.5:8787');
  });

  it('reads link codes', () => {
    expect(parseLinkCode(' https://b.example.com/#/link/abcdefghijklmnopqrstuvwxyz012345 ')).toEqual({ url: 'https://b.example.com', code: 'abcdefghijklmnopqrstuvwxyz012345' });
    expect(() => parseLinkCode('abcdefghijklmnopqrstuvwxyz012345')).toThrow(/whole link code/);
  });

  it('refuses a code pointing at a private server by default', async () => {
    const b = await makeApp();
    await seedUser(b.db, 'bob@example.com');
    const cb = await login(b.app, 'bob@example.com');
    const r = await cb.post('/api/links/connect', { code: 'https://127.0.0.1:9/#/link/abcdefghijklmnopqrstuvwxyz012345' });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/private address/);
  });
});

describe('mesh relay internals', () => {
  it('derives the root topic from the subscription when it can', () => {
    expect(rootFromTopics(['msh/US/MyTown/#'])).toBe('msh/US/MyTown');
    expect(rootFromTopics(['msh/US/MyTown/2/e/#'])).toBe('msh/US/MyTown');
    expect(rootFromTopics(['msh/#'])).toBeNull();
    expect(rootFromTopics(['msh/+/x/#'])).toBeNull();
  });

  it('reads sender and id from an envelope and ignores junk', () => {
    expect(packetKey(envelope(0xdeadbeef, 0x1234))).toBe('deadbeef:1234');
    expect(packetKey(Buffer.from('not protobuf at all'))).toBeNull();
    expect(packetKey(Buffer.alloc(0))).toBeNull();
  });

  it('retries with backoff and drops stale packets', async () => {
    let fail = true;
    const sent: RelayPacket[][] = [];
    const relay = createRelay({
      links: () => [{ id: 1, channels: ['Family'] }],
      send: async (_id, p) => { if (fail) throw new Error('down'); sent.push(p); return {}; },
      publish: () => true, root: () => 'msh/US/X', isActive: () => true,
    });
    const t0 = 1_000_000;
    relay.onLocal('msh/US/X/2/e/Family/!00000001', envelope(1, 1), t0);
    await relay.flush(t0);
    expect(relay.stats(1).error).toBe('down');
    fail = false;
    await relay.flush(t0 + 500); // still backing off
    expect(sent).toEqual([]);
    await relay.flush(t0 + 10 * 60_000); // too old to be useful now
    expect(sent).toEqual([]);
    expect(relay.stats(1).dropped).toBe(1);
  });
});
