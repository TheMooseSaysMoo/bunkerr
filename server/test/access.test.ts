import { describe, expect, it } from 'vitest';
import { client, fakeHa, login, makeApp, seedUser } from './helpers.js';
import { decisionUrl } from '../src/routes/access.js';

const req = (app: any, payload: object, ip = '203.0.113.7') =>
  app.inject({ method: 'POST', url: '/api/access-requests', payload, headers: { 'x-bunkerr': '1', 'cf-connecting-ip': ip } });

/** Path + query of a decision URL, the way a webhook router would POST it (no session, no CSRF header). */
const pathOf = (u: string) => u.replace(/^https?:\/\/[^/]+/, '');

describe('access requests', () => {
  it('request → Discord ✅ → set password → logged in with own household', async () => {
    const { app, db, sent } = await makeApp();
    const admin = await seedUser(db, 'admin@example.com', { admin: true, household: 'Maple House' });
    const r = await req(app, { email: 'Friend@Example.com', name: 'Sam', note: 'from church' });
    expect(r.statusCode).toBe(200);
    const { token } = r.json();
    await new Promise((res) => setTimeout(res, 10));

    // The admin's household got a notification carrying approve/reject actions, no secrets.
    expect(sent).toHaveLength(1);
    expect(sent[0].householdId).toBe(admin.hh);
    const actions = (sent[0].m as any).actions as string;
    const [approve, reject] = [...actions.matchAll(/http, (Approve|Reject), (\S+), method=POST/g)].map((m) => m[2]);
    expect(approve).toMatch(/\/api\/access-requests\/\d+\/approve\?exp=\d+&sig=/);
    expect(sent[0].m.lines.join('\n')).toContain('friend@example.com');

    const status = await app.inject({ method: 'GET', url: `/api/access-requests/status/${token}` });
    expect(status.json()).toMatchObject({ status: 'pending', name: 'Sam', email: 'f•••••@example.com' });

    // Registering before approval is refused.
    const early = await app.inject({ method: 'POST', url: `/api/access-requests/status/${token}/register`, headers: { 'x-bunkerr': '1' }, payload: { password: 'a-long-new-password' } });
    expect(early.statusCode).toBe(409);

    // The router performs the ✅ action: plain POST, no cookie, no X-Bunkerr.
    const ok = await app.inject({ method: 'POST', url: pathOf(approve) });
    expect(ok.statusCode).toBe(200);
    // ❌ afterwards is "already decided" (a router shows it as stale, not an error).
    expect((await app.inject({ method: 'POST', url: pathOf(reject) })).statusCode).toBe(409);

    const reg = await app.inject({ method: 'POST', url: `/api/access-requests/status/${token}/register`, headers: { 'x-bunkerr': '1' }, payload: { password: 'a-long-new-password', householdName: 'Sam house' } });
    expect(reg.statusCode).toBe(200);
    expect(reg.json()).toMatchObject({ user: { email: 'friend@example.com', name: 'Sam', isAdmin: false }, active: { name: 'Sam house', role: 'owner' } });
    expect(reg.cookies.find((c) => c.name === 'bunkerr_sid')).toBeTruthy();
    expect((await app.inject({ method: 'GET', url: `/api/access-requests/status/${token}` })).json().status).toBe('completed');
    // The link can't make a second account.
    expect((await app.inject({ method: 'POST', url: `/api/access-requests/status/${token}/register`, headers: { 'x-bunkerr': '1' }, payload: { password: 'another-long-password' } })).statusCode).toBe(409);
    await login(app, 'friend@example.com', 'a-long-new-password');
  });

  it('rejects tampered, swapped or expired decision links', async () => {
    const { app, db } = await makeApp();
    await seedUser(db, 'admin@example.com', { admin: true });
    await req(app, { email: 'x@example.com', name: 'X' });
    const id = (db.prepare('SELECT id FROM access_requests').get() as { id: number }).id;
    const good = pathOf(decisionUrl(db, id, 'approve'));
    expect((await app.inject({ method: 'POST', url: good.replace(/sig=.{4}/, 'sig=AAAA') })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: good.replace('/approve?', '/reject?') })).statusCode).toBe(403); // sig is per action
    expect((await app.inject({ method: 'POST', url: good.replace(`/${id}/`, `/${id + 1}/`) })).statusCode).toBe(403); // and per request
    const old = pathOf(decisionUrl(db, id, 'approve', Date.now() - 15 * 86400000));
    expect((await app.inject({ method: 'POST', url: old })).statusCode).toBe(410);
    expect((db.prepare('SELECT status FROM access_requests').get() as { status: string }).status).toBe('pending');
  });

  it('honeypot, duplicates, existing accounts and rate limits', async () => {
    const { app, db, sent } = await makeApp();
    await seedUser(db, 'admin@example.com', { admin: true });
    // Bot filled the hidden field: looks accepted, stores and sends nothing.
    expect((await req(app, { email: 'bot@example.com', name: 'Bot', website: 'http://spam' }, '198.51.100.1')).statusCode).toBe(200);
    expect(db.prepare('SELECT COUNT(*) AS n FROM access_requests').get()).toEqual({ n: 0 });
    expect(sent).toHaveLength(0);
    // Existing account and a duplicate pending request get the same answer.
    const a = await req(app, { email: 'ADMIN@example.com', name: 'N' }, '198.51.100.2');
    await req(app, { email: 'dup@example.com', name: 'D' }, '198.51.100.3');
    const b = await req(app, { email: 'dup@example.com', name: 'D' }, '198.51.100.3');
    expect([a.statusCode, b.statusCode]).toEqual([409, 409]);
    expect(a.json().error).toBe(b.json().error);
    // 3 per hour per IP.
    for (const n of [1, 2]) expect((await req(app, { email: `r${n}@example.com`, name: 'R' }, '198.51.100.9')).statusCode).toBe(200);
    expect((await req(app, { email: 'r3@example.com', name: 'R' }, '198.51.100.9')).statusCode).toBe(200);
    expect((await req(app, { email: 'r4@example.com', name: 'R' }, '198.51.100.9')).statusCode).toBe(429);
  });

  it('admin can approve/reject from the panel; others cannot; standby refuses', async () => {
    const { app, db } = await makeApp();
    await seedUser(db, 'admin@example.com', { admin: true });
    await seedUser(db, 'member@example.com');
    await req(app, { email: 'y@example.com', name: 'Y' });
    const id = (db.prepare('SELECT id FROM access_requests').get() as { id: number }).id;
    const member = await login(app, 'member@example.com');
    expect((await member.get('/api/admin/access-requests')).status).toBe(403);
    expect((await member.post(`/api/admin/access-requests/${id}/approve`)).status).toBe(403);
    expect((await client(app).post(`/api/admin/access-requests/${id}/approve`)).status).toBe(401);
    const admin = await login(app, 'admin@example.com');
    expect((await admin.get('/api/admin/access-requests')).json[0]).toMatchObject({ email: 'y@example.com', status: 'pending' });
    expect((await admin.post(`/api/admin/access-requests/${id}/reject`)).json).toMatchObject({ status: 'rejected' });
    expect((db.prepare('SELECT decided_by FROM access_requests').get() as { decided_by: string }).decided_by).toBe('admin@example.com');

    const standby = await makeApp({ ha: { ...fakeHa(), isActive: () => false } });
    expect((await req(standby.app, { email: 'z@example.com', name: 'Z' })).statusCode).toBe(503);
  });
});
