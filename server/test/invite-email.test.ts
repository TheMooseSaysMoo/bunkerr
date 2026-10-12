import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { client, login, makeApp, seedUser } from './helpers.js';
import { config } from '../src/config.js';
import { INVITE_EMAILS_PER_DAY } from '../src/routes/household.js';

const SMTP = { enabled: true, host: 'smtp.example.com', port: 587, security: 'starttls', user: 'b@example.com', pass: 'pw', from_email: 'b@example.com', from_name: 'Bunkerr' };

describe('email invites', () => {
  beforeEach(() => { config.internalSecret = 'test-internal-secret'; });
  afterEach(() => { config.internalSecret = ''; });

  async function setup() {
    const t = await makeApp();
    const admin = await seedUser(t.db, 'admin@example.com', { admin: true, household: 'Maple House' });
    const A = await login(t.app, 'admin@example.com');
    await A.put('/api/admin/smtp', SMTP);
    return { ...t, admin, A };
  }

  it('household invite by email: link emailed with reply-to the inviter, signup pre-fills, resend works', async () => {
    const { app, A, mails } = await setup();
    const r = (await A.post('/api/household/invites', { role: 'member', email: 'Wife@Example.com' })).json;
    expect(r).toMatchObject({ emailed: true, emailedTo: 'wife@example.com' });
    expect(r.url).toMatch(/\/#\/join\//);
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: 'wife@example.com', replyTo: 'admin@example.com', subject: '[Bunkerr] admin invited you to Maple House on Bunkerr' });
    expect(mails[0].text).toContain(r.url);
    expect(mails[0].text).toContain('as a member');

    // Invitee opens the link: email is pre-filled.
    const token = r.url.split('/join/')[1];
    expect((await client(app).get(`/api/invites/${token}`)).json).toMatchObject({ householdName: 'Maple House', role: 'member', email: 'wife@example.com' });

    // Pending list shows who and when; resend sends the same link again.
    const pending = (await A.get('/api/household')).json.invites[0];
    expect(pending).toMatchObject({ email: 'wife@example.com', emailed_at: expect.any(Number) });
    expect((await A.post(`/api/household/invites/${pending.id}/resend`, {})).json).toMatchObject({ emailed: true });
    expect(mails[1].text).toContain(r.url);
    await A.post(`/api/household/invites/${pending.id}/resend`, {});
    const fourth = await A.post(`/api/household/invites/${pending.id}/resend`, {});
    expect(fourth.status).toBe(409);
    expect(fourth.json.error).toMatch(/Already emailed 3 times/);

    // Once used, it can't be resent.
    await client(app).post('/api/auth/register', { token, email: 'wife@example.com', name: 'Wife', password: 'long-password-1' });
    expect((await A.post(`/api/household/invites/${pending.id}/resend`, {})).status).toBe(409);
  });

  it('without email set up the invite is still made and the link returned', async () => {
    const { db, A, mails } = await setup();
    db.prepare(`DELETE FROM meta WHERE key='smtp'`).run();
    const r = (await A.post('/api/household/invites', { role: 'viewer', email: 'kid@example.com' })).json;
    expect(r).toMatchObject({ emailed: false, emailError: expect.stringMatching(/isn’t set up/) });
    expect(r.url).toMatch(/\/#\/join\//);
    expect(mails).toHaveLength(0);
    // No email field at all: plain link, as before.
    expect((await A.post('/api/household/invites', { role: 'member' })).json).toMatchObject({ emailed: false });
    expect((await A.post('/api/household/invites', { role: 'member', email: '' })).json).toMatchObject({ emailed: false });
  });

  it('admin invites to start a household can be emailed; only owners invite; non-admins have a daily cap', async () => {
    const { app, db, A, mails } = await setup();
    const r = (await A.post('/api/admin/invites', { note: 'Mom & Dad', email: 'mom@example.com' })).json;
    expect(r.emailed).toBe(true);
    expect(mails[0].subject).toBe('[Bunkerr] admin invited you to Bunkerr');
    expect(mails[0].text).toContain('start your own household');
    expect((await A.get('/api/admin/overview')).json.invites[0]).toMatchObject({ email: 'mom@example.com' });

    // A member (not owner) can't invite; an owner who isn't admin hits the daily cap.
    const inv = (await A.post('/api/household/invites', { role: 'member' })).json;
    await client(app).post('/api/auth/register', { token: inv.token, email: 'm@example.com', name: 'M', password: 'long-password-1' });
    const M = await login(app, 'm@example.com', 'long-password-1');
    expect((await M.post('/api/household/invites', { email: 'x@example.com' })).status).toBe(403);
    await seedUser(db, 'friend@example.com');
    const F = await login(app, 'friend@example.com');
    db.prepare(`UPDATE invites SET email_count=?, emailed_at=? WHERE id=?`).run(INVITE_EMAILS_PER_DAY, Date.now(),
      (await F.post('/api/household/invites', { role: 'member' })).json.id);
    const capped = (await F.post('/api/household/invites', { email: 'spam@example.com' })).json;
    expect(capped).toMatchObject({ emailed: false, emailError: expect.stringMatching(/Daily limit/) });
  });
});
