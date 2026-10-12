import { describe, expect, it } from 'vitest';
import { createOffline, HttpError, OfflineError, tierOf } from './core';
import { memoryKV } from './kv';

/** A fake Bunkerr: items + one power task, an off switch, and idempotency like the real one. */
function fakeServer() {
  let nextId = 100;
  const items: any[] = [{ id: 1, name: 'Black beans, 15 oz can', category: 'food', qty: 6, unit: 'can', location: '', barcode: '037600114820', expires_on: '2027-01-01', notes: '', updated_at: 1 }];
  const power = { equipment: [{ id: 5, name: 'Anker', charge_pct: 50, tasks: [{ id: 9, label: 'Top up charge', every_days: 90, next_due_on: '2026-10-01', last_done_on: null }] }], summary: { due: [], soon: [] } };
  const seen = new Map<string, unknown>();
  const calls: string[] = [];
  const s = { down: false, items, calls, power, failStatus: 0, loseNextResponse: false };
  const handle = async (method: string, url: string, body?: any, headers?: Record<string, string>) => {
    if (s.down) throw new TypeError('Failed to fetch');
    calls.push(`${method} ${url}`);
    const key = headers?.['idempotency-key'];
    if (key && seen.has(key)) return seen.get(key);
    const done = (r: unknown) => { if (key) seen.set(key, r); return r; };
    if (s.failStatus) { const st = s.failStatus; s.failStatus = 0; throw new HttpError(st, st === 404 ? 'Item not found' : 'nope'); }
    if (url === '/healthz') return { ok: true };
    if (method === 'GET' && url.startsWith('/api/items')) return { today: '2026-10-12', items: structuredClone(items), counts: {}, devices: 1 };
    if (method === 'GET' && url === '/api/settings') return { expirySoonDays: 30, expiryUpcomingDays: 90 };
    if (method === 'GET' && url === '/api/power') return structuredClone(power);
    if (method === 'GET' && url === '/api/dashboard') return { expired: [] };
    if (method === 'POST' && url === '/api/items') { const it = { ...body, id: nextId++, updated_at: Date.now() }; items.push(it); return done(it); }
    const m = url.match(/^\/api\/items\/(-?\d+)(\/consume)?$/);
    if (m) {
      const it = items.find((i) => i.id === Number(m[1]));
      if (!it) throw new HttpError(404, 'Item not found');
      if (m[2]) { it.qty -= body.qty; if (it.qty <= 0) items.splice(items.indexOf(it), 1); return done({ id: it.id, qty: Math.max(0, it.qty), removed: it.qty <= 0 }); }
      if (method === 'PATCH') { Object.assign(it, body); return done(it); }
      if (method === 'DELETE') { items.splice(items.indexOf(it), 1); return done({ ok: true }); }
    }
    if (url === '/api/power/tasks/9/done') { power.equipment[0].tasks[0].last_done_on = body.done_on ?? '2026-10-12'; return done({ ok: true }); }
    throw new HttpError(404, 'Not found');
  };
  // loseNextResponse: the server applies the change, then the connection drops before the reply arrives.
  const raw = async (method: string, url: string, body?: any, headers?: Record<string, string>) => {
    const r = await handle(method, url, body, headers);
    if (s.loseNextResponse && method !== 'GET') { s.loseNextResponse = false; throw new TypeError('network connection was lost'); }
    return r;
  };
  return { s, raw };
}

async function setup() {
  const srv = fakeServer();
  const off = createOffline(memoryKV(), srv.raw, { today: () => '2026-10-12' });
  await off.setScope({ userId: 1, householdId: 1 });
  await off.prefetch(['/api/settings', '/api/items', '/api/power', '/api/dashboard']);
  return { ...srv, off };
}

describe('offline reads', () => {
  it('serves saved data when the server is unreachable, and answers inventory queries from the full list', async () => {
    const { s, off } = await setup();
    s.down = true;
    expect(await off.get('/api/dashboard')).toEqual({ expired: [] });
    expect(off.state().online).toBe(false);
    const r: any = await off.get('/api/items?category=food&q=beans&sort=name');
    expect(r.offline).toBe(true);
    expect(r.items.map((i: any) => i.name)).toEqual(['Black beans, 15 oz can']);
    expect(r.counts).toEqual({ food: 1 });
    expect((await off.get<any>('/api/items?category=medical')).items).toEqual([]);
    // Barcode: the household's own item still resolves offline.
    expect((await off.get<any>('/api/barcode/037600114820')).own).toMatchObject({ name: 'Black beans, 15 oz can' });
    await expect(off.get('/api/gardens')).rejects.toBeInstanceOf(OfflineError);
  });

  it('HTTP errors from Bunkerr itself are not treated as offline', async () => {
    const { s, off } = await setup();
    s.failStatus = 403;
    await expect(off.get('/api/armory')).rejects.toMatchObject({ status: 403 });
    expect(off.state().online).toBe(true);
  });

  it('saved data is per household', async () => {
    const { s, off } = await setup();
    await off.setScope({ userId: 1, householdId: 2 });
    s.down = true;
    await expect(off.get('/api/dashboard')).rejects.toBeInstanceOf(OfflineError);
  });

  it('expiry tiers', () => {
    expect(tierOf('2026-10-01', '2026-10-12')).toBe('expired');
    expect(tierOf('2026-10-20', '2026-10-12')).toBe('soon');
    expect(tierOf('2026-12-20', '2026-10-12')).toBe('upcoming');
    expect(tierOf(null, '2026-10-12')).toBe('none');
  });
});

describe('offline changes', () => {
  it('queues, shows them at once, and replays in order with temp ids swapped for real ones', async () => {
    const { s, off } = await setup();
    s.down = true;
    await off.get('/api/dashboard'); // learn we're offline
    const added: any = await off.mutate('POST', '/api/items', { name: 'Rice, 20 lb bag', qty: 2, unit: 'bag', category: 'food' });
    expect(added).toMatchObject({ queued: true, name: 'Rice, 20 lb bag' });
    expect(added.id).toBeLessThan(0);
    await off.mutate('POST', `/api/items/${added.id}/consume`, { qty: 1, kind: 'use' });
    await off.mutate('POST', '/api/items/1/consume', { qty: 2, kind: 'use' });
    await off.mutate('POST', '/api/power/tasks/9/done', { charge_pct: 100 });
    expect(off.state().pending).toBe(4);

    const view: any = await off.get('/api/items');
    expect(view.items.find((i: any) => i.name === 'Rice, 20 lb bag').qty).toBe(1);
    expect(view.items.find((i: any) => i.id === 1).qty).toBe(4);
    const pw: any = await off.get('/api/power');
    expect(pw.equipment[0]).toMatchObject({ charge_pct: 100, tasks: [{ last_done_on: '2026-10-12', next_due_on: '2027-01-10' }] });
    // Changes that need the server say so.
    await expect(off.mutate('POST', '/api/gardens', { name: 'x' })).rejects.toBeInstanceOf(OfflineError);

    s.down = false;
    await off.flush();
    expect(off.state()).toMatchObject({ pending: 0, online: true, problems: [] });
    const rice = s.items.find((i) => i.name === 'Rice, 20 lb bag');
    expect(rice.qty).toBe(1);
    expect(s.items.find((i) => i.id === 1).qty).toBe(4);
    expect(s.calls).toContain(`POST /api/items/${rice.id}/consume`);
    expect(s.power.equipment[0].tasks[0].last_done_on).toBe('2026-10-12');
  });

  it('a replay that already reached the server is not applied twice', async () => {
    const { s, off } = await setup();
    s.down = true;
    await off.get('/api/dashboard');
    await off.mutate('POST', '/api/items/1/consume', { qty: 1 });
    s.down = false;
    s.loseNextResponse = true;
    await off.flush(); // reaches the server, reply lost → stays queued
    expect(s.items[0].qty).toBe(5);
    expect(off.state().pending).toBe(1);
    await off.flush(); // replayed with the same Idempotency-Key
    expect(off.state().pending).toBe(0);
    expect(s.items[0].qty).toBe(5); // used once, not twice
  });

  it('a change the server rejects is dropped and reported; the rest still sync', async () => {
    const { s, off } = await setup();
    s.down = true;
    await off.get('/api/dashboard');
    await off.mutate('DELETE', '/api/items/1', undefined);
    await off.mutate('POST', '/api/items', { name: 'Salt', qty: 1, unit: 'ea', category: 'food' });
    s.items.splice(0, 1); // someone else deleted it meanwhile
    s.down = false;
    await off.flush();
    expect(off.state().pending).toBe(0);
    expect(off.state().problems).toEqual(['delete item: Item not found']);
    expect(s.items.map((i) => i.name)).toEqual(['Salt']);
  });

  it('stops at the first network failure and keeps the rest queued; queued changes stay in their household', async () => {
    const { s, off } = await setup();
    s.down = true;
    await off.get('/api/dashboard');
    await off.mutate('POST', '/api/items/1/consume', { qty: 1 });
    await off.setScope({ userId: 1, householdId: 2 });
    expect(off.state().pending).toBe(0); // household 2 has nothing queued
    s.down = false;
    await off.flush();
    expect(s.items[0].qty).toBe(6); // household 1's change didn't replay into household 2
    await off.setScope({ userId: 1, householdId: 1 });
    expect(off.state().pending).toBe(1);
    await off.flush();
    expect(s.items[0].qty).toBe(5);
  });

  it('logout clears everything', async () => {
    const { s, off } = await setup();
    await off.rememberMe({ user: { id: 1 } });
    s.down = true;
    await off.get('/api/dashboard');
    await off.mutate('POST', '/api/items/1/consume', { qty: 1 });
    await off.clearAll();
    expect(await off.lastMe()).toBeUndefined();
    await off.setScope({ userId: 1, householdId: 1 });
    expect(off.state().pending).toBe(0);
    await expect(off.get('/api/dashboard')).rejects.toBeInstanceOf(OfflineError);
  });
});

describe('outbox order', () => {
  it('changes made in the same millisecond replay in the order they were made', async () => {
    const { s, off } = await setup();
    s.down = true;
    await off.get('/api/dashboard');
    const realNow = Date.now;
    Date.now = () => 1_800_000_000_000; // freeze the clock
    try {
      for (let i = 0; i < 20; i++) await off.mutate('PATCH', '/api/items/1', { name: `name ${i}` });
    } finally { Date.now = realNow; }
    s.down = false;
    await off.flush();
    expect(s.items[0].name).toBe('name 19');
    expect(s.calls.filter((c) => c.startsWith('PATCH')).length).toBe(20);
  });
});
