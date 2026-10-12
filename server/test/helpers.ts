import { buildApp } from '../src/app.js';
import { openDb, type DB } from '../src/db.js';
import { hashPassword } from '../src/auth.js';
import { newIngestState } from '../src/mesh/ingest.js';
import type { Ha } from '../src/ha.js';
import type { Message, Notifier } from '../src/notify.js';
import type { Extractor } from '../src/routes/receipt.js';
import type { Mirror } from '../src/barcodes/mirror.js';
import { createMailer } from '../src/mailer.js';
import { createFederation, type FederationOptions } from '../src/federation/index.js';

export const PW = 'correct-horse-battery';

export const fakeHa = (): Ha => ({
  isActive: () => true,
  status: () => ({ node: 'test', role: 'primary', active: true, promoted: false, peerActive: false, lastSyncAt: null, lastSyncError: null }),
  promote() {}, demote() {}, async restoreFrom() {}, async snapshotTo() {}, start() {}, stop() {},
});

export interface SentMail { to: string; subject: string; text: string; html?: string; headers?: Record<string, string>; from: unknown }

export async function makeApp(opts: { extractor?: Extractor; barcodes?: Mirror; ha?: Ha; smtpFails?: string; smtpRefuses?: boolean; federation?: Partial<FederationOptions> } = {}) {
  const db = openDb(':memory:');
  const sent: { householdId: number; m: Message }[] = [];
  const notifier: Notifier = { async send(householdId, m) { sent.push({ householdId, m }); return { sent: ['fake'], errors: [] }; } };
  // Fake SMTP: records what would have been sent, with the options the transport was built from.
  const mails: SentMail[] = [];
  const transports: object[] = [];
  const mailer = createMailer(db, (o) => {
    transports.push(o);
    return {
      async sendMail(m: object) {
        if (opts.smtpFails) throw new Error(opts.smtpFails);
        const to = (m as SentMail).to;
        if (opts.smtpRefuses) return { response: '550 5.1.1 mailbox unavailable', messageId: '<x@test>', accepted: [], rejected: [to] };
        mails.push(m as SentMail);
        return { response: '250 2.0.0 Ok: queued as ABC123', messageId: `<${mails.length}@test>`, accepted: [to], rejected: [] };
      },
    };
  });
  const mesh = newIngestState();
  const ha = opts.ha ?? fakeHa();
  const federation = createFederation(db, ha, notifier, mesh, { enabled: true, publicUrl: 'https://bunkerr.test', allowPrivate: false, mqttRoot: '', mqttTopics: ['msh/#'], ...opts.federation });
  const app = await buildApp({ db, ha, notifier, mesh, extractor: opts.extractor ?? null, barcodes: opts.barcodes ?? null, mailer, federation });
  return { app, db, sent, mesh, notifier, mailer, mails, transports, federation };
}

let pwHash: string | null = null;

/** Creates a user that owns a fresh household. Returns ids. */
export async function seedUser(db: DB, email: string, opts: { admin?: boolean; household?: string } = {}) {
  pwHash ??= await hashPassword(PW);
  const t = Date.now();
  const uid = Number(db.prepare('INSERT INTO users (email,name,pw_hash,is_admin,created_at) VALUES (?,?,?,?,?)').run(email, email.split('@')[0], pwHash, opts.admin ? 1 : 0, t).lastInsertRowid);
  const hh = Number(db.prepare('INSERT INTO households (name,created_at) VALUES (?,?)').run(opts.household ?? `${email} home`, t).lastInsertRowid);
  db.prepare(`INSERT INTO memberships (user_id,household_id,role,created_at) VALUES (?,?,'owner',?)`).run(uid, hh, t);
  return { uid, hh };
}

type App = Awaited<ReturnType<typeof makeApp>>['app'];

export async function login(app: App, email: string, password = PW) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password }, headers: { 'x-bunkerr': '1' } });
  if (res.statusCode !== 200) throw new Error(`login failed ${res.statusCode} ${res.body}`);
  const c = res.cookies.find((c) => c.name === 'bunkerr_sid')!;
  return client(app, `bunkerr_sid=${c.value}`);
}

export function client(app: App, cookie = '') {
  const req = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE') => async (url: string, payload?: unknown) => {
    const res = await app.inject({ method, url, payload: payload as object, headers: { cookie, 'x-bunkerr': '1' } });
    let json: any = null;
    try { json = res.json(); } catch { /* not json */ }
    return { status: res.statusCode, json, res };
  };
  return { cookie, get: req('GET'), post: req('POST'), patch: req('PATCH'), put: req('PUT'), del: req('DELETE') };
}
