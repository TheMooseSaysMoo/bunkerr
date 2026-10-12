import crypto from 'node:crypto';
import { config } from './config.js';
import type { DB } from './db.js';

/**
 * Secrets at rest. The SMTP password and access-request links are sealed with AES-256-GCM,
 * using a key derived from INTERNAL_SECRET. That value is the same on both hosts and lives in
 * .env, not the database, so a copied bunkerr.db or snapshot doesn't reveal them. Without
 * INTERNAL_SECRET (local dev) values are stored as plain text, marked as such.
 */
const key = () => (config.internalSecret ? crypto.createHash('sha256').update(`bunkerr-seal:${config.internalSecret}`).digest() : null);

export function seal(plain: string): string {
  const k = key();
  if (!k) return `plain:${plain}`;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1:${iv.toString('base64url')}:${c.getAuthTag().toString('base64url')}:${ct.toString('base64url')}`;
}

/** Null when it can't be opened (wrong or missing INTERNAL_SECRET, corrupted value). */
export function unseal(sealed: string | null | undefined): string | null {
  if (!sealed) return null;
  if (sealed.startsWith('plain:')) return sealed.slice(6);
  const [v, iv, tag, ct] = sealed.split(':');
  const k = key();
  if (v !== 'v1' || !k || !iv || !tag || ct == null) return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** Random per-instance HMAC key kept in the database, so signed links survive a failover to the standby. */
export function instanceKey(db: DB, name: string): string {
  const k = `hmac_${name}`;
  const row = db.prepare('SELECT value FROM meta WHERE key=?').get(k) as { value: string } | undefined;
  if (row) return row.value;
  db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING').run(k, crypto.randomBytes(32).toString('base64url'));
  return (db.prepare('SELECT value FROM meta WHERE key=?').get(k) as { value: string }).value;
}

export const hmac = (db: DB, name: string, data: string) => crypto.createHmac('sha256', instanceKey(db, name)).update(data).digest('base64url');

export function hmacEqual(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
