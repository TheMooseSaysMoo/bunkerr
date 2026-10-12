import { describe, expect, it } from 'vitest';
import { addDays, daysBetween, expiryTier } from '../src/util.js';
import { inBounds, overlaps, plantingStatus } from '../src/garden-logic.js';
import { handlePacket, nodeIdFromNum } from '../src/mesh/ingest.js';
import { runDigests, runMeshAlerts } from '../src/scheduler.js';
import { login, makeApp, seedUser } from './helpers.js';

const log = { info() {}, warn() {} };

describe('dates & expiry', () => {
  it('computes day differences across months/leap years', () => {
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2);
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
  });
  it('tiers', () => {
    const t = '2026-10-11';
    expect(expiryTier(null, t)).toBe('none');
    expect(expiryTier('2026-10-10', t)).toBe('expired');
    expect(expiryTier('2026-10-11', t)).toBe('soon');
    expect(expiryTier('2026-11-10', t)).toBe('soon');
    expect(expiryTier('2026-11-11', t)).toBe('upcoming');
    expect(expiryTier('2027-06-01', t)).toBe('ok');
  });
});

describe('garden logic', () => {
  const tomato = { days_to_germ: 7, days_to_maturity: 75, water_every_days: 2 };
  it('stages and watering', () => {
    const p = { planted_on: '2026-05-10', last_watered: '2026-05-10', harvested_on: null };
    expect(plantingStatus(p, tomato, '2026-05-12')).toMatchObject({ stage: 'sown', water_due: true, germ_on: '2026-05-17', harvest_on: '2026-07-24' });
    expect(plantingStatus({ ...p, last_watered: '2026-06-01' }, tomato, '2026-06-02')).toMatchObject({ stage: 'growing', water_due: false, next_water: '2026-06-03' });
    expect(plantingStatus(p, tomato, '2026-07-24').stage).toBe('ready');
    expect(plantingStatus({ ...p, harvested_on: '2026-08-01' }, tomato, '2026-08-02')).toMatchObject({ stage: 'harvested', water_due: false });
  });
  it('rect math', () => {
    expect(overlaps({ row: 0, col: 0, w: 2, h: 2 }, { row: 1, col: 1, w: 1, h: 1 })).toBe(true);
    expect(overlaps({ row: 0, col: 0, w: 2, h: 2 }, { row: 0, col: 2, w: 1, h: 1 })).toBe(false);
    expect(inBounds({ row: 3, col: 7, w: 1, h: 1 }, 4, 8)).toBe(true);
    expect(inBounds({ row: 3, col: 7, w: 2, h: 1 }, 4, 8)).toBe(false);
  });
  it('rejects overlapping plantings via the API', async () => {
    const { app, db } = await makeApp();
    await seedUser(db, 'g@example.com');
    const C = await login(app, 'g@example.com');
    const g = (await C.post('/api/gardens', { name: 'Bed', rows: 4, cols: 4 })).json;
    expect((await C.post(`/api/gardens/${g.id}/plantings`, { plant_id: 1, row: 0, col: 0, w: 2, h: 2 })).status).toBe(200);
    expect((await C.post(`/api/gardens/${g.id}/plantings`, { plant_id: 2, row: 1, col: 1, w: 1, h: 1 })).status).toBe(409);
    expect((await C.post(`/api/gardens/${g.id}/plantings`, { plant_id: 2, row: 3, col: 3, w: 2, h: 1 })).status).toBe(400);
    expect((await C.patch(`/api/gardens/${g.id}`, { rows: 1 })).status).toBe(409);
  });
});

describe('inventory', () => {
  it('merges identical batches and removes empty ones', async () => {
    const { app, db } = await makeApp();
    await seedUser(db, 'i@example.com');
    const C = await login(app, 'i@example.com');
    const a = (await C.post('/api/items', { name: 'Black beans', qty: 6, unit: 'can', expires_on: '2028-01-01', location: 'Basement' })).json;
    const b = (await C.post('/api/items', { name: 'black beans', qty: 6, unit: 'can', expires_on: '2028-01-01', location: 'Basement' })).json;
    expect(b.id).toBe(a.id);
    expect(b.qty).toBe(12);
    await C.post('/api/items', { name: 'Black beans', qty: 2, unit: 'can', expires_on: '2029-01-01', location: 'Basement' });
    expect((await C.get('/api/items')).json.items).toHaveLength(2);
    expect((await C.post(`/api/items/${a.id}/consume`, { qty: 12 })).json.removed).toBe(true);
    expect((await C.get('/api/items')).json.items).toHaveLength(1);
  });

  it('low stock and food/water days on the dashboard', async () => {
    const { app, db } = await makeApp();
    await seedUser(db, 'd@example.com');
    const C = await login(app, 'd@example.com');
    await C.post('/api/items/bulk', { items: [
      { name: 'Rice', qty: 20, unit: 'lb', kcal_per_unit: 1650, min_qty: 25 },
      { name: 'Water', category: 'water', qty: 14, unit: 'gal' },
    ] });
    const d = (await C.get('/api/dashboard')).json;
    expect(d.lowStock[0]).toMatchObject({ name: 'Rice', total: 20 });
    expect(d.foodDays).toBeCloseTo(8.25); // 33000 kcal / (2 people * 2000)
    expect(d.waterDays).toBe(7);
  });

  it('receipt import validates and enforces quota', async () => {
    let calls = 0;
    const { app, db } = await makeApp({ extractor: async () => { calls++; return { items: [{ name: 'Peanut butter', qty: 2, unit: 'jar', category: 'food', expires_on: 'soon', notes: '' }], warnings: [] }; } });
    const { hh } = await seedUser(db, 'r@example.com');
    db.prepare('UPDATE households SET receipt_quota=1 WHERE id=?').run(hh);
    const C = await login(app, 'r@example.com');
    const img = 'A'.repeat(200);
    const r1 = await C.post('/api/receipt', { image: img, mediaType: 'image/jpeg' });
    expect(r1.status).toBe(200);
    expect(r1.json.items[0].expires_on).toBeNull(); // invalid date dropped
    expect((await C.post('/api/receipt', { image: img, mediaType: 'image/jpeg' })).status).toBe(429);
    expect(calls).toBe(1);
  });
});

describe('mesh ingest', () => {
  it('stores only claimed nodes, into the claiming household', async () => {
    const { app, db, mesh } = await makeApp();
    const { hh } = await seedUser(db, 'm@example.com');
    const C = await login(app, 'm@example.com');
    const from = 0xa1b2c3d4;
    expect(nodeIdFromNum(from)).toBe('!a1b2c3d4');

    expect(handlePacket(db, mesh, { from, type: 'nodeinfo', payload: { longname: 'Hilltop V4', shortname: 'HIL4', hardware: 43 } })).toBeNull();
    expect(mesh.unclaimed.get('!a1b2c3d4')?.long_name).toBe('Hilltop V4');

    const n = (await C.post('/api/mesh/nodes', { node_id: '!a1b2c3d4', site: 'Home' })).json;
    expect(n.long_name).toBe('Hilltop V4'); // filled from the unclaimed cache
    expect(n.hw_model).toBe('Heltec V3');
    expect(handlePacket(db, mesh, { from, type: 'telemetry', sender: '!0000beef', rssi: -80, snr: 7.5, payload: { battery_level: 87, voltage: 4.05, channel_utilization: 6.2, air_util_tx: 1.1, uptime_seconds: 3600 } })).toBe(hh);
    handlePacket(db, mesh, { from, type: 'position', payload: { latitude_i: 391000000, longitude_i: -843500000 } });

    const view = (await C.get('/api/mesh')).json;
    expect(view.nodes[0]).toMatchObject({ battery: 87, ch_util: 6.2, rssi: -80, online: true, lat: 39.1, lon: -84.35, via_gateway: '!0000beef' });
    expect((await C.get(`/api/mesh/nodes/${n.id}/telemetry`)).json).toHaveLength(1);
  });

  it('alerts once when offline, once when back', async () => {
    const { app, db, mesh, sent, notifier } = await makeApp();
    const { hh } = await seedUser(db, 'o@example.com');
    const C = await login(app, 'o@example.com');
    await C.post('/api/mesh/nodes', { node_id: '!00000001', label: 'Car' });
    handlePacket(db, mesh, { from: 1, type: 'telemetry', payload: { battery_level: 90 } }, Date.now() - 5 * 3600000);
    await runMeshAlerts(db, notifier, log);
    await runMeshAlerts(db, notifier, log);
    expect(sent.filter((s) => s.m.title.startsWith('Mesh node offline'))).toHaveLength(1);
    handlePacket(db, mesh, { from: 1, type: 'telemetry', payload: { battery_level: 90 } });
    await runMeshAlerts(db, notifier, log);
    await runMeshAlerts(db, notifier, log);
    expect(sent.filter((s) => s.m.title.startsWith('Mesh node back online'))).toHaveLength(1);
    expect(sent.every((s) => s.householdId === hh)).toBe(true);
  });
});

describe('digest', () => {
  it('sends one digest per household per day, after the configured time, only with content', async () => {
    const { app, db, sent, notifier } = await makeApp();
    const a = await seedUser(db, 'a@example.com');
    const b = await seedUser(db, 'b@example.com');
    const A = await login(app, 'a@example.com');
    await A.post('/api/items', { name: 'Old soup', qty: 1, unit: 'can', expires_on: '2001-01-01' });

    const early = new Date('2026-10-11T11:00:00Z'); // 07:00 New York
    const late = new Date('2026-10-11T13:00:00Z'); // 09:00 New York
    await runDigests(db, notifier, log, early);
    expect(sent).toHaveLength(0);
    await runDigests(db, notifier, log, late);
    await runDigests(db, notifier, log, late);
    expect(sent).toHaveLength(1);
    expect(sent[0].householdId).toBe(a.hh);
    expect(sent[0].m.lines.join('\n')).toContain('Old soup');
    void b;
  });
});

describe('notifier: webhook router primary with direct fallback', () => {
  const mk = (name: string, ok: boolean, calls: string[]) => ({
    name, enabled: () => true,
    async send() { calls.push(name); if (!ok) throw new Error('down'); },
  });

  it('uses the router alone when it works, falls back to direct providers when it fails', async () => {
    const { createNotifier } = await import('../src/notify.js');
    const { getSettings, saveSettings } = await import('../src/settings.js');
    const { db } = await makeApp();
    const { hh } = await seedUser(db, 'n@example.com');
    const s = getSettings(db, hh);
    saveSettings(db, hh, { ...s, notify: { ...s.notify, router: true } });

    const calls: string[] = [];
    const ok = createNotifier(db, [mk('discord', true, calls)], mk('router', true, calls));
    expect(await ok.send(hh, { title: 't', lines: [] })).toEqual({ sent: ['router'], errors: [] });
    expect(calls).toEqual(['router']);

    calls.length = 0;
    const down = createNotifier(db, [mk('discord', true, calls)], mk('router', false, calls));
    const r = await down.send(hh, { title: 't', lines: [] });
    expect(calls).toEqual(['router', 'discord']);
    expect(r.sent).toEqual(['discord']);
    expect(r.errors[0]).toMatch(/falling back/);
  });

  it('only instance admins can toggle the webhook router', async () => {
    const { app, db } = await makeApp();
    await seedUser(db, 'admin@example.com', { admin: true });
    await seedUser(db, 'owner@example.com');
    for (const [email, expected] of [['admin@example.com', true], ['owner@example.com', false]] as const) {
      const C = await login(app, email);
      const s = (await C.get('/api/settings')).json;
      s.notify.router = true;
      expect((await C.put('/api/settings', s)).json.notify.router).toBe(expected);
    }
  });
});

describe('snapshot backups', () => {
  it('writes a readable snapshot and keeps only N', async () => {
    const os = await import('node:os'); const fs = await import('node:fs'); const path = await import('node:path');
    const { snapshotBackup } = await import('../src/scheduler.js');
    const { db } = await makeApp();
    await seedUser(db, 'b@example.com');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunkerr-bk-'));
    for (const d of ['2026-10-01', '2026-10-02', '2026-10-03']) await snapshotBackup(db, dir, 2, d);
    expect(fs.readdirSync(path.join(dir, 'backups')).sort()).toEqual(['bunkerr-2026-10-02.db', 'bunkerr-2026-10-03.db']);
    const { openDb } = await import('../src/db.js');
    const copy = openDb(path.join(dir, 'backups', 'bunkerr-2026-10-03.db'));
    expect((copy.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
