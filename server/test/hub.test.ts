import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { client, fakeHa, makeApp, seedUser } from './helpers.js';

const TOKEN = 'hub-token-0123456789abcdef0123456789abcdef';
const auth = { authorization: `Bearer ${TOKEN}` };

describe('family hub provisioning', () => {
  beforeEach(() => { config.hubToken = TOKEN; });
  afterEach(() => { config.hubToken = ''; });

  it('creates an account that owns a new household, and can log in', async () => {
    const { app, db } = await makeApp();
    const st = await app.inject({ method: 'GET', url: '/api/hub/accounts?email=Sam@Example.com', headers: auth });
    expect(st.json()).toEqual({ exists: false });

    const res = await app.inject({ method: 'POST', url: '/api/hub/accounts', headers: auth, payload: { email: 'Sam@Example.com', name: 'Sam', password: 'a-long-family-passphrase' } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ outcome: 'created', email: 'sam@example.com' });
    const m = db.prepare(`SELECT h.name, m.role, u.is_admin FROM users u JOIN memberships m ON m.user_id=u.id JOIN households h ON h.id=m.household_id WHERE u.email='sam@example.com'`).all();
    expect(m).toEqual([{ name: "Sam's household", role: 'owner', is_admin: 0 }]);

    // Login is case-insensitive on email.
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-bunkerr': '1' }, payload: { email: 'SAM@example.com', password: 'a-long-family-passphrase' } });
    expect(login.statusCode).toBe(200);
    expect(login.json().active.name).toBe("Sam's household");

    expect((await app.inject({ method: 'GET', url: '/api/hub/accounts?email=sam@example.com', headers: auth })).json()).toMatchObject({ exists: true });
  });

  it('never touches an existing account', async () => {
    const { app, db } = await makeApp();
    await seedUser(db, 'jordan@example.com');
    const before = db.prepare(`SELECT pw_hash, name FROM users WHERE email='jordan@example.com'`).get();
    const res = await app.inject({ method: 'POST', url: '/api/hub/accounts', headers: auth, payload: { email: 'JORDAN@example.com', name: 'Mallory', password: 'attacker-chosen-password' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().outcome).toBe('already_exists');
    expect(db.prepare(`SELECT pw_hash, name FROM users WHERE email='jordan@example.com'`).get()).toEqual(before);
    expect(db.prepare('SELECT COUNT(*) AS n FROM households').get()).toEqual({ n: 1 });
  });

  it('is closed without the token, through Cloudflare, when disabled, or on an inactive instance', async () => {
    const { app } = await makeApp();
    const post = (headers: Record<string, string>) => app.inject({ method: 'POST', url: '/api/hub/accounts', headers, payload: { email: 'x@example.com', name: 'X', password: 'a-long-family-passphrase' } });
    expect((await post({})).statusCode).toBe(403);
    expect((await post({ authorization: 'Bearer wrong' })).statusCode).toBe(403);
    expect((await post({ ...auth, 'cf-connecting-ip': '1.2.3.4' })).statusCode).toBe(404);
    // A logged-in user's session doesn't open it either.
    expect((await client(app).post('/api/hub/accounts', { email: 'x@example.com', name: 'X', password: 'a-long-family-passphrase' })).status).toBe(403);
    config.hubToken = '';
    expect((await post(auth)).statusCode).toBe(404);

    config.hubToken = TOKEN;
    const standby = await makeApp({ ha: { ...fakeHa(), isActive: () => false } });
    const r = await standby.app.inject({ method: 'POST', url: '/api/hub/accounts', headers: auth, payload: { email: 'x@example.com', name: 'X', password: 'a-long-family-passphrase' } });
    expect(r.statusCode).toBe(503);
    expect(standby.db.prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 0 });
  });

  it('validates input', async () => {
    const { app } = await makeApp();
    const post = (payload: object) => app.inject({ method: 'POST', url: '/api/hub/accounts', headers: auth, payload });
    expect((await post({ email: 'not-an-email', name: 'X', password: 'a-long-family-passphrase' })).statusCode).toBe(400);
    expect((await post({ email: 'x@example.com', name: '', password: 'a-long-family-passphrase' })).statusCode).toBe(400);
    expect((await post({ email: 'x@example.com', name: 'X', password: 'short' })).statusCode).toBe(400);
  });
});
