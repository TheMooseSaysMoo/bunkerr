import { describe, expect, it } from 'vitest';
import { login, makeApp, seedUser } from './helpers.js';

// Zod 4 fills in .default() values on .partial() schemas; a PATCH must only change what was sent.
describe('partial updates', () => {
  it('keep the fields a PATCH leaves out', async () => {
    const { app, db } = await makeApp();
    await seedUser(db, 'pat@example.com');
    const c = await login(app, 'pat@example.com');

    const item = (await c.post('/api/items', { name: 'Ibuprofen', category: 'medical', qty: 2, unit: 'bottle', location: 'bathroom', notes: 'kids too' })).json;
    expect((await c.patch(`/api/items/${item.id}`, { qty: 3 })).json).toMatchObject({ qty: 3, category: 'medical', unit: 'bottle', location: 'bathroom', notes: 'kids too' });

    const part = (await c.post('/api/armory/parts', { category: 'optic', make: 'Holosun', model: '507C', serial: 'H123', qty: 1, notes: 'zeroed 25y' })).json;
    expect((await c.patch(`/api/armory/parts/${part.id}`, { firearm_id: null })).status).toBe(200);
    expect(db.prepare('SELECT category, make, serial, notes FROM firearm_parts WHERE id=?').get(part.id)).toEqual({ category: 'optic', make: 'Holosun', serial: 'H123', notes: 'zeroed 25y' });

    const ammo = (await c.post('/api/armory/ammo', { caliber: '9mm', brand: 'Speer', line: 'Gold Dot', purpose: 'defense', rounds: 50, location: 'safe' })).json;
    await c.patch(`/api/armory/ammo/${ammo.id}`, { rounds: 40 });
    expect(db.prepare('SELECT brand, line, purpose, rounds, location FROM ammo WHERE id=?').get(ammo.id)).toEqual({ brand: 'Speer', line: 'Gold Dot', purpose: 'defense', rounds: 40, location: 'safe' });

    const eq = (await c.post('/api/power', { name: 'Generac', kind: 'generator', brand: 'Generac', serial: 'G9', fuel: 'gas', notes: '10W-30', tasks: [{ label: 'Change oil', every_days: 365, notes: '0.6 qt' }] })).json;
    expect((await c.patch(`/api/power/${eq.id}`, { charge_pct: 80 })).status).toBe(200);
    expect(db.prepare('SELECT kind, brand, serial, fuel, notes, charge_pct FROM equipment WHERE id=?').get(eq.id)).toEqual({ kind: 'generator', brand: 'Generac', serial: 'G9', fuel: 'gas', notes: '10W-30', charge_pct: 80 });
    // The editor re-sends each reminder without its notes.
    const task = db.prepare('SELECT id FROM equipment_tasks WHERE equipment_id=?').get(eq.id) as { id: number };
    expect((await c.patch(`/api/power/tasks/${task.id}`, { label: 'Change oil' })).status).toBe(200);
    expect(db.prepare('SELECT every_days, notes FROM equipment_tasks WHERE id=?').get(task.id)).toEqual({ every_days: 365, notes: '0.6 qt' });
  });
});
