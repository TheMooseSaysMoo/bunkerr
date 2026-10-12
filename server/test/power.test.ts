import { describe, expect, it } from 'vitest';
import { client, login, makeApp, seedUser } from './helpers.js';
import { digestLines, householdSummary } from '../src/summary.js';
import { addDays, todayIn } from '../src/util.js';

const today = () => todayIn('America/New_York');

describe('power equipment', () => {
  it('a new device gets the suggested reminder 3 months out; done reschedules from the done date', async () => {
    const { app, db } = await makeApp();
    await seedUser(db, 'o@example.com');
    const O = await login(app, 'o@example.com');
    const { id } = (await O.post('/api/power', { name: 'Anker 20K', kind: 'power_bank', capacity_mah: 20000, charge_pct: 60 })).json;
    let ov = (await O.get('/api/power')).json;
    const eq = ov.equipment.find((e: any) => e.id === id);
    expect(eq.tasks).toHaveLength(1);
    expect(eq.tasks[0]).toMatchObject({ label: 'Top up charge', every_days: 90, next_due_on: addDays(today(), 90), state: 'ok' });
    expect(ov.options.suggestions.generator.map((s: any) => s.label)).toContain('Change oil');

    const done = (await O.post(`/api/power/tasks/${eq.tasks[0].id}/done`, { done_on: addDays(today(), -10), charge_pct: 100 })).json;
    expect(done).toMatchObject({ last_done_on: addDays(today(), -10), next_due_on: addDays(today(), 80) });
    ov = (await O.get('/api/power')).json;
    expect(ov.equipment[0].charge_pct).toBe(100);
    expect((await O.get(`/api/power/${id}/log`)).json[0]).toMatchObject({ task_label: 'Top up charge', charge_pct: 100 });
    expect((await O.post(`/api/power/tasks/${eq.tasks[0].id}/done`, { done_on: addDays(today(), 1) })).status).toBe(400);
  });

  it('reminder dates are set by hand; changing the interval re-suggests unless a date is given', async () => {
    const { app, db } = await makeApp();
    await seedUser(db, 'o@example.com');
    const O = await login(app, 'o@example.com');
    const manual = addDays(today(), 14);
    const { id } = (await O.post('/api/power', {
      name: 'Garage generator', kind: 'generator', output_w: 3500, fuel: 'dual fuel', run_hours: 41.5,
      tasks: [{ label: 'Run under load 20–30 min', every_days: 90, next_due_on: manual }, { label: 'Change oil', every_days: 365, last_done_on: addDays(today(), -400) }],
    })).json;
    const tasks = (await O.get('/api/power')).json.equipment.find((e: any) => e.id === id).tasks;
    const run = tasks.find((t: any) => t.label.startsWith('Run'));
    const oil = tasks.find((t: any) => t.label === 'Change oil');
    expect(run.next_due_on).toBe(manual);
    expect(oil).toMatchObject({ next_due_on: addDays(today(), -35), state: 'due' }); // last done 400d ago + 365

    const r = (await O.patch(`/api/power/tasks/${run.id}`, { label: run.label, every_days: 30 })).json;
    expect(r.next_due_on).toBe(addDays(today(), 30));
    const r2 = (await O.patch(`/api/power/tasks/${run.id}`, { label: run.label, every_days: 60, next_due_on: addDays(today(), 3) })).json;
    expect(r2.next_due_on).toBe(addDays(today(), 3));

    // Due and due-soon reach the dashboard; due reaches the digest.
    const sum = householdSummary(db, (db.prepare('SELECT household_id AS h FROM equipment').get() as { h: number }).h);
    expect(sum.power.due.map((t) => t.label)).toEqual(['Change oil']);
    expect(sum.power.soon.map((t) => t.label)).toEqual(['Run under load 20–30 min']);
    expect(digestLines(sum).join('\n')).toMatch(/POWER UPKEEP DUE \(1\)\n {2}⚡ Garage generator\s+Change oil\s+35d ago/);
    expect((await O.get('/api/dashboard')).json.power.due).toHaveLength(1);
  });

  it('deleting a device removes its reminders; households are isolated; viewers read only', async () => {
    const { app, db } = await makeApp();
    await seedUser(db, 'a@example.com');
    await seedUser(db, 'b@example.com');
    const A = await login(app, 'a@example.com');
    const B = await login(app, 'b@example.com');
    const { id } = (await A.post('/api/power', { name: 'Office UPS', kind: 'ups' })).json;
    const taskId = (await A.get('/api/power')).json.equipment[0].tasks[0].id;

    expect((await B.get('/api/power')).json.equipment).toHaveLength(0);
    expect((await B.patch(`/api/power/${id}`, { name: 'mine now' })).status).toBe(404);
    expect((await B.post(`/api/power/tasks/${taskId}/done`, {})).status).toBe(404);
    expect((await B.del(`/api/power/tasks/${taskId}`)).status).toBe(404);
    expect((await B.get(`/api/power/${id}/log`)).status).toBe(404);

    const inv = (await A.post('/api/household/invites', { role: 'viewer' })).json;
    await client(app).post('/api/auth/register', { token: inv.token, email: 'kid@example.com', name: 'Kid', password: 'kid-password-1' });
    const V = await login(app, 'kid@example.com', 'kid-password-1');
    expect((await V.get('/api/power')).json.equipment).toHaveLength(1);
    expect((await V.post(`/api/power/tasks/${taskId}/done`, {})).status).toBe(403);
    expect((await V.post('/api/power', { name: 'x' })).status).toBe(403);

    expect((await A.del(`/api/power/${id}`)).status).toBe(200);
    expect(db.prepare('SELECT COUNT(*) AS n FROM equipment_tasks').get()).toEqual({ n: 0 });
  });
});
