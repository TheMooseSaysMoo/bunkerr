import { describe, expect, it } from 'vitest';
import { client, login, makeApp, seedUser } from './helpers.js';

async function twoHouseholds() {
  const ctx = await makeApp();
  const a = await seedUser(ctx.db, 'alice@example.com', { admin: true });
  const b = await seedUser(ctx.db, 'bob@example.com');
  const A = await login(ctx.app, 'alice@example.com');
  const B = await login(ctx.app, 'bob@example.com');
  return { ...ctx, a, b, A, B };
}

describe('household isolation', () => {
  it('items: cannot read, edit, consume or delete another household’s item by id', async () => {
    const { A, B } = await twoHouseholds();
    const item = (await A.post('/api/items', { name: 'Rice', qty: 10, unit: 'lb' })).json;
    expect(item.id).toBeGreaterThan(0);

    expect((await B.get('/api/items')).json.items).toHaveLength(0);
    expect((await B.patch(`/api/items/${item.id}`, { qty: 0 })).status).toBe(404);
    expect((await B.post(`/api/items/${item.id}/consume`, { qty: 1 })).status).toBe(404);
    expect((await B.del(`/api/items/${item.id}`)).status).toBe(404);
    expect((await A.get('/api/items')).json.items[0].qty).toBe(10);
  });

  it('gardens and plantings are isolated', async () => {
    const { A, B } = await twoHouseholds();
    const g = (await A.post('/api/gardens', { name: 'Raised bed', rows: 4, cols: 8 })).json;
    const p = (await A.post(`/api/gardens/${g.id}/plantings`, { plant_id: 1, row: 0, col: 0, w: 1, h: 1 })).json;
    expect((await B.get(`/api/gardens/${g.id}`)).status).toBe(404);
    expect((await B.post(`/api/gardens/${g.id}/plantings`, { plant_id: 1, row: 1, col: 1, w: 1, h: 1 })).status).toBe(404);
    expect((await B.patch(`/api/plantings/${p.id}`, { row: 2 })).status).toBe(404);
    expect((await B.del(`/api/plantings/${p.id}`)).status).toBe(404);
    expect((await B.post(`/api/gardens/${g.id}/water`, {})).status).toBe(404);
    expect((await B.get('/api/gardens')).json).toHaveLength(0);
  });

  it('custom plants are private to the household', async () => {
    const { A, B } = await twoHouseholds();
    const plant = (await A.post('/api/plants', { name: 'Pawpaw', glyph: 'PW', color: '#88aa22', days_to_germ: 30, days_to_maturity: 700, water_every_days: 5, spacing_in: 120 })).json;
    const bPlants = (await B.get('/api/plants')).json as { id: number }[];
    expect(bPlants.find((p) => p.id === plant.id)).toBeUndefined();
    const g = (await B.post('/api/gardens', { name: 'B bed', rows: 2, cols: 2 })).json;
    expect((await B.post(`/api/gardens/${g.id}/plantings`, { plant_id: plant.id, row: 0, col: 0, w: 1, h: 1 })).status).toBe(404);
  });

  it('mesh nodes: one claim per node, invisible to others', async () => {
    const { A, B } = await twoHouseholds();
    const n = (await A.post('/api/mesh/nodes', { node_id: '!A1B2C3D4', label: 'Home V4' })).json;
    expect(n.node_id).toBe('!a1b2c3d4');
    const dup = await B.post('/api/mesh/nodes', { node_id: 'a1b2c3d4' });
    expect(dup.status).toBe(409);
    expect(dup.json.error).toBe('That node is already claimed');
    expect((await B.get('/api/mesh')).json.nodes).toHaveLength(0);
    expect((await B.get(`/api/mesh/nodes/${n.id}/telemetry`)).status).toBe(404);
    expect((await B.del(`/api/mesh/nodes/${n.id}`)).status).toBe(404);
  });

  it('settings are per household and secrets hidden from non-owners', async () => {
    const { A, B, app, db, a } = await twoHouseholds();
    const s = (await A.get('/api/settings')).json;
    s.notify.discordWebhook = 'https://discord.com/api/webhooks/123/abcdefghijklmnop';
    expect((await A.put('/api/settings', s)).status).toBe(200);
    expect((await B.get('/api/settings')).json.notify.discordWebhook).toBe('');

    // add a viewer to A's household
    const inv = (await A.post('/api/household/invites', { role: 'viewer' })).json;
    const V = client(app);
    const reg = await V.post('/api/auth/register', { token: inv.token, email: 'viewer@example.com', name: 'Vee', password: 'viewer-password-1' });
    expect(reg.status).toBe(200);
    expect(reg.json.active.id).toBe(a.hh);
    const Vc = await login(app, 'viewer@example.com', 'viewer-password-1');
    expect((await Vc.get('/api/settings')).json.notify.discordWebhook).toMatch(/…/);
    void db;
  });

  it('cannot switch into a household you are not a member of', async () => {
    const { A, b } = await twoHouseholds();
    expect((await A.post('/api/households/switch', { householdId: b.hh })).status).toBe(404);
  });

  it('dashboard and export only include own data', async () => {
    const { A, B } = await twoHouseholds();
    await A.post('/api/items', { name: 'Secret beans', qty: 3, unit: 'can', expires_on: '2000-01-01' });
    expect((await B.get('/api/dashboard')).json.expired).toHaveLength(0);
    expect((await B.get('/api/items/export.csv')).res.body).not.toContain('Secret beans');
  });
});

describe('roles and invites', () => {
  it('viewer is read-only', async () => {
    const { A, app } = await twoHouseholds();
    const inv = (await A.post('/api/household/invites', { role: 'viewer' })).json;
    await client(app).post('/api/auth/register', { token: inv.token, email: 'v@example.com', name: 'V', password: 'viewer-password-1' });
    const V = await login(app, 'v@example.com', 'viewer-password-1');
    expect((await V.get('/api/items')).status).toBe(200);
    expect((await V.post('/api/items', { name: 'x' })).status).toBe(403);
    expect((await V.post('/api/gardens', { name: 'x', rows: 1, cols: 1 })).status).toBe(403);
    expect((await V.post('/api/household/invites', {})).status).toBe(403);
  });

  it('members cannot manage the household', async () => {
    const { A, app } = await twoHouseholds();
    const inv = (await A.post('/api/household/invites', { role: 'member' })).json;
    await client(app).post('/api/auth/register', { token: inv.token, email: 'm@example.com', name: 'M', password: 'member-password-1' });
    const M = await login(app, 'm@example.com', 'member-password-1');
    expect((await M.post('/api/items', { name: 'Water', category: 'water', qty: 5, unit: 'gal' })).status).toBe(200);
    expect((await M.put('/api/settings', {})).status).toBe(403);
    expect((await M.patch('/api/household', { name: 'pwned' })).status).toBe(403);
  });

  it('invites are single-use, expire, and can be revoked', async () => {
    const { A, app, db } = await twoHouseholds();
    const inv = (await A.post('/api/household/invites', { role: 'member' })).json;
    const anon = client(app);
    expect((await anon.post('/api/auth/register', { token: inv.token, email: 'x1@example.com', name: 'X', password: 'password-123456' })).status).toBe(200);
    expect((await anon.post('/api/auth/register', { token: inv.token, email: 'x2@example.com', name: 'X', password: 'password-123456' })).status).toBe(410);

    const inv2 = (await A.post('/api/household/invites', {})).json;
    db.prepare('UPDATE invites SET expires_at=1 WHERE id=(SELECT MAX(id) FROM invites)').run();
    expect((await anon.get(`/api/invites/${inv2.token}`)).status).toBe(410);

    const inv3 = (await A.post('/api/household/invites', {})).json;
    const list = (await A.get('/api/household')).json.invites as { id: number }[];
    await A.del(`/api/household/invites/${list[0].id}`);
    expect((await anon.post('/api/auth/register', { token: inv3.token, email: 'x3@example.com', name: 'X', password: 'password-123456' })).status).toBe(410);
  });

  it('a removed member loses access immediately', async () => {
    const { A, app, a } = await twoHouseholds();
    const inv = (await A.post('/api/household/invites', { role: 'member' })).json;
    const reg = await client(app).post('/api/auth/register', { token: inv.token, email: 'gone@example.com', name: 'G', password: 'password-123456' });
    const G = await login(app, 'gone@example.com', 'password-123456');
    expect((await G.get('/api/me')).json.active.id).toBe(a.hh);
    await A.post('/api/items', { name: 'Ammo box' });
    expect((await G.get('/api/items')).json.items).toHaveLength(1);
    expect((await A.del(`/api/household/members/${reg.json.user.id}`)).status).toBe(200);
    // G belongs to no household now
    expect((await G.get('/api/items')).status).toBe(409);
    expect((await G.get('/api/me')).json.active).toBeNull();
  });

  it('new-household invite creates a household owned by the invitee; user can also create more', async () => {
    const { A, app } = await twoHouseholds();
    const inv = (await A.post('/api/admin/invites', { note: 'Mom & Dad' })).json;
    const C = client(app);
    const reg = await C.post('/api/auth/register', { token: inv.token, email: 'mom@example.com', name: 'Mom', password: 'password-123456', householdName: 'Cabin house' });
    expect(reg.json.active).toMatchObject({ name: 'Cabin house', role: 'owner' });
    const C2 = await login(app, 'mom@example.com', 'password-123456');
    const made = (await C2.post('/api/households', { name: 'Cabin' })).json;
    expect(made.households).toHaveLength(2);
    expect(made.active.name).toBe('Cabin');
  });

  it('non-admins cannot use admin routes; last owner cannot leave', async () => {
    const { B, b } = await twoHouseholds();
    expect((await B.get('/api/admin/overview')).status).toBe(403);
    expect((await B.post('/api/admin/invites', {})).status).toBe(403);
    expect((await B.del(`/api/household/members/${b.uid}`)).status).toBe(400);
  });

  it('rejects mutating requests without the CSRF header and unauthenticated access', async () => {
    const { app, A } = await twoHouseholds();
    const res = await app.inject({ method: 'POST', url: '/api/items', payload: { name: 'x' }, headers: { cookie: A.cookie } });
    expect(res.statusCode).toBe(403);
    expect((await client(app).get('/api/items')).status).toBe(401);
  });
});
