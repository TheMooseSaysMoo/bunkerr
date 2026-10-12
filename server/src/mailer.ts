import nodemailer from 'nodemailer';
import { z } from 'zod';
import { config } from './config.js';
import type { DB } from './db.js';
import { hmac, seal, unseal } from './secrets.js';

/**
 * Email: one SMTP server for the whole instance (set by the admin in Settings), and people
 * subscribing themselves to their households' alerts. Every alert email carries a signed
 * one-click unsubscribe link.
 */

export const SMTP_SECURITY = ['starttls', 'tls', 'none'] as const;
export const smtpInput = z.object({
  enabled: z.boolean().default(false),
  host: z.string().trim().max(200).default(''),
  port: z.number().int().min(1).max(65535).default(587),
  security: z.enum(SMTP_SECURITY).default('starttls'),
  user: z.string().trim().max(200).default(''),
  /** undefined keeps the stored password, '' clears it. */
  pass: z.string().max(500).optional(),
  from_email: z.union([z.email().max(200), z.literal('')]).default(''),
  from_name: z.string().trim().max(80).default('Bunkerr'),
});
type SmtpStored = Omit<z.infer<typeof smtpInput>, 'pass'> & { pass_sealed: string | null };
export type SmtpPublic = Omit<SmtpStored, 'pass_sealed'> & { has_password: boolean; ready: boolean; password_unreadable: boolean };

const DEFAULTS: SmtpStored = { enabled: false, host: '', port: 587, security: 'starttls', user: '', from_email: '', from_name: 'Bunkerr', pass_sealed: null };

function stored(db: DB): SmtpStored {
  const row = db.prepare(`SELECT value FROM meta WHERE key='smtp'`).get() as { value: string } | undefined;
  return row ? { ...DEFAULTS, ...JSON.parse(row.value) } : DEFAULTS;
}

const isReady = (s: SmtpStored) => s.enabled && !!s.host && !!s.from_email;

export function smtpPublic(db: DB): SmtpPublic {
  const { pass_sealed, ...s } = stored(db);
  return { ...s, has_password: !!pass_sealed, ready: isReady(stored(db)), password_unreadable: !!pass_sealed && unseal(pass_sealed) == null };
}

export function saveSmtp(db: DB, input: z.infer<typeof smtpInput>) {
  const cur = stored(db);
  const { pass, ...rest } = input;
  const next: SmtpStored = { ...rest, pass_sealed: pass === undefined ? cur.pass_sealed : pass === '' ? null : seal(pass) };
  db.prepare(`INSERT INTO meta(key,value) VALUES('smtp',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(JSON.stringify(next));
}

export interface Mail { to: string; subject: string; text: string; html?: string; headers?: Record<string, string>; replyTo?: string }
/** What the SMTP server said: the final reply line (often with a queue id) and who it took. */
export interface SendResult { response: string; messageId: string; accepted: string[]; rejected: string[] }
export interface Mailer { ready(): boolean; send(m: Mail): Promise<SendResult> }
export type TransportFactory = (opts: object) => { sendMail(m: object): Promise<unknown> };

export function createMailer(db: DB, factory: TransportFactory = (o) => nodemailer.createTransport(o)): Mailer {
  let cache: { key: string; t: ReturnType<TransportFactory> } | null = null;
  const transport = (s: SmtpStored) => {
    const key = JSON.stringify(s);
    if (cache?.key !== key) {
      const pass = unseal(s.pass_sealed);
      if (s.pass_sealed && pass == null) throw new Error('The stored SMTP password can’t be decrypted (INTERNAL_SECRET changed?). Enter it again.');
      cache = {
        key,
        t: factory({
          host: s.host, port: s.port,
          secure: s.security === 'tls',
          requireTLS: s.security === 'starttls',
          ignoreTLS: s.security === 'none',
          auth: s.user ? { user: s.user, pass: pass ?? '' } : undefined,
          connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
        }),
      };
    }
    return cache.t;
  };
  return {
    ready: () => isReady(stored(db)),
    async send(m) {
      const s = stored(db);
      if (!isReady(s)) throw new Error('Email is not set up');
      const info = await transport(s).sendMail({ from: { name: s.from_name || 'Bunkerr', address: s.from_email }, to: m.to, replyTo: m.replyTo, subject: m.subject, text: m.text, html: m.html, headers: m.headers }) as
        { response?: string; messageId?: string; accepted?: (string | { address: string })[]; rejected?: (string | { address: string })[] };
      const addr = (a: string | { address: string }) => (typeof a === 'string' ? a : a.address);
      const r: SendResult = { response: String(info?.response ?? '').slice(0, 300), messageId: String(info?.messageId ?? ''), accepted: (info?.accepted ?? []).map(addr), rejected: (info?.rejected ?? []).map(addr) };
      // A server can take the message but refuse the recipient; that's a failure, not a send.
      if (r.rejected.length && !r.accepted.length) throw new Error(`recipient refused by ${s.host}: ${r.rejected.join(', ')} (${r.response})`);
      return r;
    },
  };
}

// ---------------- alert emails ----------------

export type EmailKind = 'digest' | 'alerts';

export const unsubscribeSig = (db: DB, userId: number, householdId: number, kind: EmailKind) => hmac(db, 'unsubscribe', `${userId}:${householdId}:${kind}`);
export const unsubscribeUrl = (db: DB, userId: number, householdId: number, kind: EmailKind) =>
  `${config.publicUrl}/api/email/unsubscribe?u=${userId}&h=${householdId}&k=${kind}&sig=${unsubscribeSig(db, userId, householdId, kind)}`;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** Plain text plus a small monospace HTML version. Subscription emails get the unsubscribe footer. */
export function renderAlert(o: { title: string; lines: string[]; url?: string; footer?: { household: string; why: string; unsubscribe?: string } }): { text: string; html: string } {
  const f = o.footer;
  const footer = f ? [`You get this because you subscribed to ${f.why} for ${f.household}.`, `Manage email: ${config.publicUrl}/#/settings`, ...(f.unsubscribe ? [`Unsubscribe: ${f.unsubscribe}`] : [])] : [];
  const text = [o.title, '', ...o.lines, '', ...(o.url ? [o.url, ''] : []), ...(f ? ['-- ', ...footer] : [])].join('\n');
  const html = `<!doctype html><html><body style="margin:0;padding:16px;background:#0a0e0b;color:#dbe7dd;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace">
<div style="max-width:640px;margin:0 auto;border:1px solid #263629;border-radius:8px;padding:16px;background:#121a14">
<div style="color:#5ee38a;font-weight:700;margin-bottom:12px">$ ${esc(o.title)}</div>
<pre style="white-space:pre-wrap;font-size:14px;line-height:1.5;margin:0 0 16px">${esc(o.lines.join('\n'))}</pre>
${o.url ? `<a href="${esc(o.url)}" style="display:inline-block;background:#5ee38a;color:#04140a;padding:8px 14px;border-radius:6px;text-decoration:none;font-weight:700">open bunkerr</a>` : ''}
${f ? `<p style="color:#8aa08f;font-size:12px;margin:18px 0 0">${esc(footer[0])}<br><a style="color:#8aa08f" href="${esc(`${config.publicUrl}/#/settings`)}">Manage email</a>${f.unsubscribe ? ` · <a style="color:#8aa08f" href="${esc(f.unsubscribe)}">Unsubscribe</a>` : ''}</p>` : ''}
</div></body></html>`;
  return { text, html };
}

interface Recipient { user_id: number; email: string; role: string }

/**
 * Emails a household alert to its members who subscribed to that kind. Membership is joined
 * in, so someone removed from a household stops getting its email immediately.
 * `viewerLines` replaces the body for viewers (e.g. the digest without armory lines).
 */
export async function emailHousehold(db: DB, mailer: Mailer, householdId: number, kind: EmailKind,
  m: { title: string; lines: string[]; url?: string; viewerLines?: string[] }): Promise<{ sent: number; errors: string[] }> {
  if (!mailer.ready()) return { sent: 0, errors: [] };
  const hh = db.prepare('SELECT name FROM households WHERE id=?').get(householdId) as { name: string } | undefined;
  if (!hh) return { sent: 0, errors: [] };
  const rows = db.prepare(`SELECT u.id AS user_id, u.email, m.role FROM email_subscriptions s
    JOIN users u ON u.id=s.user_id AND u.disabled=0
    JOIN memberships m ON m.user_id=s.user_id AND m.household_id=s.household_id
    WHERE s.household_id=? AND s.${kind === 'digest' ? 'digest' : 'alerts'}=1`).all(householdId) as Recipient[];
  let sent = 0;
  const errors: string[] = [];
  for (const r of rows) {
    const unsubscribe = unsubscribeUrl(db, r.user_id, householdId, kind);
    const lines = r.role === 'viewer' && m.viewerLines ? m.viewerLines : m.lines;
    if (!lines.length) continue;
    const body = renderAlert({ title: m.title, lines, url: m.url, footer: { household: hh.name, unsubscribe, why: kind === 'digest' ? 'the daily digest' : 'urgent alerts' } });
    try {
      await mailer.send({
        to: r.email, subject: `[Bunkerr] ${m.title}`, ...body,
        headers: { 'List-Unsubscribe': `<${unsubscribe}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
      });
      sent++;
    } catch (e) {
      errors.push(`email ${r.email}: ${(e as Error).message}`);
    }
  }
  return { sent, errors };
}
