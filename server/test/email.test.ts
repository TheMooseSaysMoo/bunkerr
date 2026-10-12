import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { client, login, makeApp, seedUser } from './helpers.js';
import { config } from '../src/config.js';
import { createNotifier } from '../src/notify.js';
import { runDigests } from '../src/scheduler.js';
import { getSettings, saveSettings } from '../src/settings.js';

const SMTP = { enabled: true, host: 'smtp.example.com', port: 587, security: 'starttls', user: 'bunkerr@example.com', pass: 'app-password-123', from_email: 'bunkerr@example.com', from_name: 'Bunkerr' };
const NINE_AM_ET = new Date('2026-10-12T13:00:00Z');

async function setup(opts: { smtpFails?: string } = {}) {
  const t = await makeApp(opts);
  const admin = await seedUser(t.db, 'admin@example.com', { admin: true, household: 'Maple House' });
  const A = await login(t.app, 'admin@example.com');
  return { ...t, admin, A };
}

describe('email (SMTP) settings', () => {
  beforeEach(() => { config.internalSecret = 'test-internal-secret'; });
  afterEach(() => { config.internalSecret = ''; });

  it('admin configures SMTP; the password is sealed at rest and never returned', async () => {
    const { app, db, A, mails, transports } = await setup();
    await seedUser(db, 'm@example.com');
    const M = await login(app, 'm@example.com');
    expect((await M.get('/api/admin/smtp')).status).toBe(403);
    expect((await M.put('/api/admin/smtp', SMTP)).status).toBe(403);

    const saved = (await A.put('/api/admin/smtp', SMTP)).json;
    expect(saved).toMatchObject({ enabled: true, host: 'smtp.example.com', has_password: true, ready: true });
    expect(JSON.stringify(saved)).not.toContain('app-password-123');
    const raw = (db.prepare(`SELECT value FROM meta WHERE key='smtp'`).get() as { value: string }).value;
    expect(raw).not.toContain('app-password-123');
    expect(raw).toMatch(/"pass_sealed":"v1:/);

    // Saving without a password keeps it; '' clears it.
    await A.put('/api/admin/smtp', { ...SMTP, pass: undefined, from_name: 'Prep' });
    expect((await A.get('/api/admin/smtp')).json).toMatchObject({ has_password: true, from_name: 'Prep' });

    expect((await A.post('/api/admin/smtp/test', {})).json).toMatchObject({ ok: true, to: 'admin@example.com', host: 'smtp.example.com', response: '250 2.0.0 Ok: queued as ABC123', accepted: ['admin@example.com'], rejected: [] });
    expect(transports.at(-1)).toMatchObject({ host: 'smtp.example.com', port: 587, secure: false, requireTLS: true, auth: { user: 'bunkerr@example.com', pass: 'app-password-123' } });
    expect(mails[0]).toMatchObject({ to: 'admin@example.com', subject: '[Bunkerr] Test email', from: { name: 'Prep', address: 'bunkerr@example.com' } });
    expect(mails[0].html).toContain('comms check');

    expect((await A.put('/api/admin/smtp', { ...SMTP, host: '' })).status).toBe(400);
    expect((await A.get('/api/me')).json.features.email).toBe(true);
  });

  it('a recipient the server refuses is an error, not a silent success', async () => {
    const { A } = await setup({ smtpRefuses: true });
    await A.put('/api/admin/smtp', SMTP);
    const r = await A.post('/api/admin/smtp/test', {});
    expect(r.status).toBe(502);
    expect(r.json.error).toMatch(/recipient refused by smtp\.example\.com: admin@example\.com \(550 5\.1\.1/);
  });

  it('a failing SMTP server reports its error to the admin', async () => {
    const { A } = await setup({ smtpFails: 'Invalid login: 535 5.7.8 Username and Password not accepted' });
    await A.put('/api/admin/smtp', SMTP);
    const r = await A.post('/api/admin/smtp/test', {});
    expect(r.status).toBe(502);
    expect(r.json.error).toMatch(/535 5\.7\.8/);
  });
});

describe('email alert subscriptions', () => {
  beforeEach(() => { config.internalSecret = 'test-internal-secret'; });
  afterEach(() => { config.internalSecret = ''; });

  it('people subscribe themselves; the digest goes only to subscribers, viewers without armory lines', async () => {
    const { app, db, A, admin, mailer, mails } = await setup();
    await A.put('/api/admin/smtp', SMTP);
    // Household: owner (admin), a member and a viewer, plus a stranger in another household.
    const invite = async (role: string, email: string) => {
      const inv = (await A.post('/api/household/invites', { role })).json;
      await client(app).post('/api/auth/register', { token: inv.token, email, name: email.split('@')[0], password: 'long-password-1' });
      return login(app, email, 'long-password-1');
    };
    const M = await invite('member', 'wife@example.com');
    const V = await invite('viewer', 'kid@example.com');
    const other = await seedUser(db, 'stranger@example.com');
    const S = await login(app, 'stranger@example.com');

    expect((await M.get('/api/me/email')).json).toMatchObject({ available: true, households: [{ name: 'Maple House', digest: false, alerts: false }], accessRequests: null });
    expect((await M.put(`/api/me/email/households/${admin.hh}`, { digest: true, alerts: true })).status).toBe(200);
    expect((await V.put(`/api/me/email/households/${admin.hh}`, { digest: true, alerts: false })).status).toBe(200);
    expect((await S.put(`/api/me/email/households/${admin.hh}`, { digest: true, alerts: true })).status).toBe(404); // not a member
    // One box at a time keeps the other (two quick taps in the UI).
    await A.put(`/api/me/email/households/${admin.hh}`, { digest: true });
    await A.put(`/api/me/email/households/${admin.hh}`, { alerts: true });
    expect((await A.get('/api/me/email')).json.households[0]).toMatchObject({ digest: true, alerts: true });
    await A.put(`/api/me/email/households/${admin.hh}`, { digest: false, alerts: false });
    expect((await S.put(`/api/me/email/households/${other.hh}`, { digest: true, alerts: true })).status).toBe(200);

    // Something to report: an expired item, plus low ammo with armory-in-digest on.
    db.prepare(`INSERT INTO items (household_id,name,category,qty,unit,location,expires_on,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).run(admin.hh, 'Old soup', 'food', 2, 'can', '', '2026-01-01', 1, 1);
    await A.post('/api/armory/ammo', { caliber: '9mm', rounds: 10, min_rounds: 500 });
    saveSettings(db, admin.hh, { ...getSettings(db, admin.hh), armoryDigest: true });

    await runDigests(db, createNotifier(db, [], null, mailer), console, NINE_AM_ET);
    const to = mails.map((m) => m.to).sort();
    expect(to).toEqual(['kid@example.com', 'wife@example.com']); // not the owner (didn't subscribe), not the stranger (nothing to report)
    const wife = mails.find((m) => m.to === 'wife@example.com')!;
    const kid = mails.find((m) => m.to === 'kid@example.com')!;
    expect(wife.subject).toBe('[Bunkerr] Bunkerr daily — Maple House — 2026-10-12');
    expect(wife.text).toContain('Old soup');
    expect(wife.text).toContain('LOW AMMO');
    expect(kid.text).toContain('Old soup');
    expect(kid.text).not.toContain('LOW AMMO');
    expect(wife.headers?.['List-Unsubscribe']).toMatch(/^<http.*\/api\/email\/unsubscribe\?u=\d+&h=\d+&k=digest&sig=/);
    expect(wife.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');

    // Removed from the household: no more email.
    const wifeId = (db.prepare(`SELECT id FROM users WHERE email='wife@example.com'`).get() as { id: number }).id;
    db.prepare('DELETE FROM memberships WHERE user_id=?').run(wifeId);
    db.prepare('DELETE FROM notifications').run();
    mails.length = 0;
    await runDigests(db, createNotifier(db, [], null, mailer), console, NINE_AM_ET);
    expect(mails.map((m) => m.to)).toEqual(['kid@example.com']);
  });

  it('unsubscribe: GET only asks, POST with a valid signature unsubscribes', async () => {
    const { app, db, A, admin, mailer, mails } = await setup();
    await A.put('/api/admin/smtp', SMTP);
    await A.put(`/api/me/email/households/${admin.hh}`, { digest: true, alerts: true });
    db.prepare(`INSERT INTO items (household_id,name,category,qty,unit,location,expires_on,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).run(admin.hh, 'Old soup', 'food', 2, 'can', '', '2026-01-01', 1, 1);
    await runDigests(db, createNotifier(db, [], null, mailer), console, NINE_AM_ET);
    const url = mails[0].headers!['List-Unsubscribe'].slice(1, -1).replace(/^https?:\/\/[^/]+/, '');

    const get = await app.inject({ method: 'GET', url });
    expect(get.statusCode).toBe(200);
    expect(get.body).toContain('<form method="post">');
    expect((await A.get('/api/me/email')).json.households[0].digest).toBe(true);

    expect((await app.inject({ method: 'POST', url: url.replace(/sig=.{5}/, 'sig=AAAAA') })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: url.replace('k=digest', 'k=alerts') })).statusCode).toBe(400); // sig is per kind
    // Mail apps' one-click unsubscribe: form-encoded POST, no cookie, no CSRF header.
    const post = await app.inject({ method: 'POST', url, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'List-Unsubscribe=One-Click' });
    expect(post.statusCode).toBe(200);
    expect((await A.get('/api/me/email')).json.households[0]).toMatchObject({ digest: false, alerts: true });
  });

  it('access requests: requester gets the link by email, and again on approval; opted-in admins are told', async () => {
    const { app, A, mails } = await setup();
    await A.put('/api/admin/smtp', SMTP);
    await A.put('/api/me/email/access-requests', { on: true });
    const r = await app.inject({ method: 'POST', url: '/api/access-requests', headers: { 'x-bunkerr': '1' }, payload: { email: 'sam@example.com', name: 'Sam' } });
    const { token } = r.json();
    await new Promise((res) => setTimeout(res, 20));
    const toSam = mails.find((m) => m.to === 'sam@example.com')!;
    expect(toSam.subject).toBe('[Bunkerr] We got your access request');
    expect(toSam.text).toContain(`/#/request/${token}`);
    expect(toSam.text).not.toContain('Unsubscribe');
    expect(mails.find((m) => m.to === 'admin@example.com')?.subject).toBe('[Bunkerr] Access request: Sam');

    const id = (await A.get('/api/admin/access-requests')).json[0].id;
    await A.post(`/api/admin/access-requests/${id}/approve`);
    await new Promise((res) => setTimeout(res, 20));
    const approved = mails.find((m) => m.subject === '[Bunkerr] You’re approved')!;
    expect(approved.to).toBe('sam@example.com');
    expect(approved.text).toContain(`/#/request/${token}`);
  });
});
