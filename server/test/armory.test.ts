import { describe, expect, it } from 'vitest';
import { caliberKey, caliberLabel, chamberAccepts } from '../src/calibers.js';
import { digestLines, householdSummary } from '../src/summary.js';
import { getSettings, saveSettings } from '../src/settings.js';
import { client, login, makeApp, seedUser } from './helpers.js';

const rifle = { make: 'Ruger', model: 'AR-556', variant: 'MPR', type: 'rifle', action: 'semi-auto', caliber: '5.56', serial: 'ABC123456', clean_every: 500 };

describe('calibers', () => {
  it('normalizes spellings and knows one-way compatibility', () => {
    expect(caliberKey('9x19')).toBe('9mm');
    expect(caliberKey('9mm Luger')).toBe('9mm');
    expect(caliberKey('.223 Rem')).toBe('223rem');
    expect(caliberKey('5.56 NATO')).toBe('556nato');
    expect(caliberLabel('12 ga')).toBe('12 gauge');
    expect(chamberAccepts('5.56')).toEqual(['556nato', '223rem']);
    expect(chamberAccepts('.223')).toEqual(['223rem']); // .223 chamber does NOT list 5.56
    expect(chamberAccepts('357 mag')).toContain('38spl');
    expect(caliberKey('6.8 Western')).toBe('6.8 western'); // unknown stays as typed
  });
});

describe('armory', () => {
  it('range session updates counts, undo reverses, cleaning becomes due', async () => {
    const { app, db } = await makeApp();
    await seedUser(db, 'a@example.com');
    const A = await login(app, 'a@example.com');
    const f = (await A.post('/api/armory/firearms', rifle)).json;
    const lot = (await A.post('/api/armory/ammo', { caliber: '.223 Remington', brand: 'Federal', grain: 55, bullet: 'FMJ', rounds: 600, min_rounds: 1000 })).json;
    expect(lot.caliber).toBe('.223 Remington');

    const detail = (await A.get(`/api/armory/firearms/${f.id}`)).json;
    expect(detail.ammo.map((a: { id: number }) => a.id)).toEqual([lot.id]); // .223 counted for a 5.56 chamber
    expect(detail.firearm.serial).toBe('ABC123456');

    const s = (await A.post('/api/armory/sessions', { firearm_id: f.id, ammo_id: lot.id, rounds: 520 })).json;
    let ov = (await A.get('/api/armory')).json;
    expect(ov.ammo[0].rounds).toBe(80);
    expect(ov.firearms[0]).toMatchObject({ round_count: 520, cleaning_due: true, serial: '••••3456' });
    expect(ov.summary.lowAmmo[0]).toMatchObject({ key: '223rem', rounds: 80, min: 1000 });

    await A.post(`/api/armory/firearms/${f.id}/cleaned`, {});
    expect((await A.get('/api/armory')).json.firearms[0].cleaning_due).toBe(false);

    await A.del(`/api/armory/sessions/${s.id}`);
    ov = (await A.get('/api/armory')).json;
    expect(ov.ammo[0].rounds).toBe(600);
    expect(ov.firearms[0].round_count).toBe(0);
    expect(ov.sessions).toHaveLength(0);
  });

  it('parts attach to a firearm and become spares when it is deleted', async () => {
    const { app, db } = await makeApp();
    await seedUser(db, 'p@example.com');
    const A = await login(app, 'p@example.com');
    const f = (await A.post('/api/armory/firearms', rifle)).json;
    await A.post('/api/armory/parts', { firearm_id: f.id, category: 'optic', make: 'Vortex', model: 'Strike Eagle 1-8x' });
    expect((await A.get(`/api/armory/firearms/${f.id}`)).json.parts).toHaveLength(1);
    await A.del(`/api/armory/firearms/${f.id}`);
    const ov = (await A.get('/api/armory')).json;
    expect(ov.parts[0]).toMatchObject({ firearm_id: null, model: 'Strike Eagle 1-8x' });
  });

  it('is isolated per household', async () => {
    const { app, db } = await makeApp();
    await seedUser(db, 'a@example.com');
    await seedUser(db, 'b@example.com');
    const A = await login(app, 'a@example.com');
    const B = await login(app, 'b@example.com');
    const f = (await A.post('/api/armory/firearms', rifle)).json;
    const lot = (await A.post('/api/armory/ammo', { caliber: '9mm', rounds: 100 })).json;
    expect((await B.get(`/api/armory/firearms/${f.id}`)).status).toBe(404);
    expect((await B.patch(`/api/armory/ammo/${lot.id}`, { rounds: 0 })).status).toBe(404);
    expect((await B.post('/api/armory/sessions', { firearm_id: f.id, rounds: 1 })).status).toBe(404);
    expect((await B.post('/api/armory/parts', { firearm_id: f.id, model: 'x' })).status).toBe(404);
    expect((await B.get('/api/armory')).json.firearms).toHaveLength(0);
    expect((await B.get('/api/armory/export.csv')).res.body).not.toContain('ABC123456');
  });

  it('is hidden from viewers unless enabled; viewers never see full serials or the export', async () => {
    const { app, db } = await makeApp();
    const { hh } = await seedUser(db, 'o@example.com');
    const O = await login(app, 'o@example.com');
    const f = (await O.post('/api/armory/firearms', rifle)).json;
    const inv = (await O.post('/api/household/invites', { role: 'viewer' })).json;
    await client(app).post('/api/auth/register', { token: inv.token, email: 'kid@example.com', name: 'Kid', password: 'kid-password-1' });
    const V = await login(app, 'kid@example.com', 'kid-password-1');
    expect((await V.get('/api/armory')).status).toBe(403);
    expect((await V.get('/api/me')).json.armoryVisible).toBe(false);
    expect((await V.get('/api/dashboard')).json.armory).toBeNull();

    saveSettings(db, hh, { ...getSettings(db, hh), armoryViewers: true });
    expect((await V.get('/api/armory')).status).toBe(200);
    expect((await V.get(`/api/armory/firearms/${f.id}`)).json.firearm.serial).toBe('••••3456');
    expect((await V.get('/api/armory/export.csv')).status).toBe(403);
    expect((await V.post('/api/armory/ammo', { caliber: '9mm', rounds: 1 })).status).toBe(403);
  });

  it('digest mentions low ammo only when opted in, and never serials', async () => {
    const { app, db } = await makeApp();
    const { hh } = await seedUser(db, 'd@example.com');
    const A = await login(app, 'd@example.com');
    await A.post('/api/armory/firearms', rifle);
    await A.post('/api/armory/ammo', { caliber: '5.56', rounds: 50, min_rounds: 500 });
    expect(digestLines(householdSummary(db, hh)).join('\n')).not.toContain('LOW AMMO');
    saveSettings(db, hh, { ...getSettings(db, hh), armoryDigest: true });
    const text = digestLines(householdSummary(db, hh)).join('\n');
    expect(text).toContain('LOW AMMO');
    expect(text).not.toContain('ABC123456');
  });
});

describe('armory on/off', () => {
  it('owners can turn the armory off: hidden for everyone, API refuses, nothing deleted', async () => {
    const { app, db } = await makeApp();
    const { hh } = await seedUser(db, 'o@example.com');
    const O = await login(app, 'o@example.com');
    await O.post('/api/armory/ammo', { caliber: '9mm', rounds: 50, min_rounds: 500 });
    saveSettings(db, hh, { ...getSettings(db, hh), armoryDigest: true });
    expect((await O.get('/api/me')).json.armoryVisible).toBe(true);

    // Members can't change household settings; owners can.
    const inv = (await O.post('/api/household/invites', { role: 'member' })).json;
    await client(app).post('/api/auth/register', { token: inv.token, email: 'm@example.com', name: 'M', password: 'long-password-1' });
    const M = await login(app, 'm@example.com', 'long-password-1');
    const settings = (await O.get('/api/settings')).json;
    expect(settings.armoryEnabled).toBe(true);
    expect((await M.put('/api/settings', { ...settings, armoryEnabled: false })).status).toBe(403);
    expect((await O.put('/api/settings', { ...settings, armoryEnabled: false })).status).toBe(200);

    for (const who of [O, M]) {
      expect((await who.get('/api/me')).json.armoryVisible).toBe(false);
      expect((await who.get('/api/armory')).status).toBe(403);
      expect((await who.get('/api/dashboard')).json.armory).toBeNull();
    }
    expect((await O.post('/api/armory/ammo', { caliber: '9mm', rounds: 1 })).status).toBe(403);
    expect(digestLines(householdSummary(db, hh)).join('\n')).not.toContain('LOW AMMO');
    expect(db.prepare('SELECT COUNT(*) AS n FROM ammo WHERE household_id=?').get(hh)).toEqual({ n: 1 });

    await O.put('/api/settings', { ...settings, armoryEnabled: true });
    expect((await O.get('/api/armory')).json.ammo).toHaveLength(1);
    expect(digestLines(householdSummary(db, hh)).join('\n')).toContain('LOW AMMO');
  });
});
