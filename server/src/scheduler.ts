import cron from 'node-cron';
import fs from 'node:fs';
import path from 'node:path';
import type { DB } from './db.js';
import type { Ha } from './ha.js';
import { claimNotification, releaseNotification, type Notifier } from './notify.js';
import { digestLines, householdSummary } from './summary.js';
import { getSettings } from './settings.js';
import { hhmmIn, todayIn } from './util.js';
import { config } from './config.js';
import { IDEMPOTENCY_TTL_MS } from './idempotency.js';

type Log = { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void };

const households = (db: DB) => (db.prepare('SELECT id, name FROM households').all() as { id: number; name: string }[]);

/** Sends today's digest for any household whose digest time has passed. Safe to call every minute. */
export async function runDigests(db: DB, notifier: Notifier, log: Log, at = new Date()) {
  for (const h of households(db)) {
    const s = getSettings(db, h.id);
    if (!s.digestEnabled) continue;
    const today = todayIn(s.timezone, at);
    if (hhmmIn(s.timezone, at) < s.digestTime) continue;
    if (!claimNotification(db, h.id, 'digest', today)) continue;
    const sum = householdSummary(db, h.id);
    const lines = digestLines(sum);
    if (!lines.length) continue; // nothing to report today
    // Viewers' email copy leaves armory lines out unless the household shows the armory to viewers.
    const viewerLines = s.armoryEnabled && s.armoryDigest && !s.armoryViewers ? digestLines({ ...sum, settings: { ...sum.settings, armoryDigest: false } }) : undefined;
    const r = await notifier.send(h.id, { title: `Bunkerr daily — ${h.name} — ${today}`, lines, viewerLines, url: config.publicUrl, email: 'digest' });
    if (r.errors.length && !r.sent.length) {
      log.warn({ household: h.id, errors: r.errors }, 'digest failed; will retry');
      releaseNotification(db, h.id, 'digest', today);
    }
  }
}

/** Immediate alerts: node went offline / came back / low battery. */
export async function runMeshAlerts(db: DB, notifier: Notifier, log: Log) {
  for (const h of households(db)) {
    const s = getSettings(db, h.id);
    const offlineMs = s.meshOfflineMinutes * 60000;
    const today = todayIn(s.timezone);
    const nodes = db.prepare('SELECT node_id,label,long_name,site,last_heard,battery FROM mesh_nodes WHERE household_id=? AND last_heard IS NOT NULL').all(h.id) as
      { node_id: string; label: string; long_name: string | null; site: string; last_heard: number; battery: number | null }[];
    for (const n of nodes) {
      const name = `${n.label || n.long_name || n.node_id}${n.site ? ` @ ${n.site}` : ''}`;
      const ref = `${n.node_id}:${n.last_heard}`;
      const send = (title: string, lines: string[], priority: 'high' | 'default') =>
        notifier.send(h.id, { title, lines, priority, url: `${config.publicUrl}/#/mesh`, email: 'alerts' }).then((r) => r.errors.length && log.warn({ errors: r.errors }, 'mesh alert failed'));
      if (Date.now() - n.last_heard >= offlineMs) {
        if (claimNotification(db, h.id, 'mesh-offline', ref)) {
          await send(`Mesh node offline: ${name}`, [`Last heard ${new Date(n.last_heard).toLocaleString('en-US', { timeZone: s.timezone })}`, `Threshold: ${s.meshOfflineMinutes} min`], 'high');
        }
      } else {
        const pending = db.prepare(`SELECT ref FROM notifications WHERE household_id=? AND kind='mesh-offline' AND ref LIKE ? AND ref NOT IN
          (SELECT ref FROM notifications WHERE household_id=? AND kind='mesh-online')`).all(h.id, `${n.node_id}:%`, h.id) as { ref: string }[];
        for (const p of pending) {
          if (claimNotification(db, h.id, 'mesh-online', p.ref)) await send(`Mesh node back online: ${name}`, ['Heard again just now.'], 'default');
        }
      }
      if (n.battery != null && n.battery <= s.meshLowBattery && claimNotification(db, h.id, 'mesh-battery', `${n.node_id}:${today}`)) {
        await send(`Low battery: ${name}`, [`Battery ${n.battery}% (threshold ${s.meshLowBattery}%)`], 'default');
      }
    }
  }
}

export function prune(db: DB) {
  const t = Date.now();
  db.prepare('DELETE FROM mesh_telemetry WHERE at < ?').run(t - 30 * 86400000);
  db.prepare('DELETE FROM notifications WHERE sent_at < ?').run(t - 90 * 86400000);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(t);
  db.prepare('DELETE FROM invites WHERE expires_at < ? AND used_by IS NULL').run(t - 30 * 86400000);
  db.prepare('DELETE FROM item_events WHERE at < ?').run(t - 365 * 86400000);
  db.prepare('DELETE FROM idempotency WHERE created_at < ?').run(t - IDEMPOTENCY_TTL_MS);
  db.prepare(`DELETE FROM access_requests WHERE status IN ('pending','rejected','approved') AND created_at < ?`).run(t - 90 * 86400000);
}

/**
 * Consistent daily snapshot into <dataDir>/backups (keeps 14), so a normal file backup picks up
 * a clean file instead of a live WAL database.
 */
export async function snapshotBackup(db: DB, dataDir: string, keep = 14, day = new Date().toISOString().slice(0, 10)) {
  const dir = path.join(dataDir, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  await db.backup(path.join(dir, `bunkerr-${day}.db`));
  const files = fs.readdirSync(dir).filter((f) => /^bunkerr-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) fs.rmSync(path.join(dir, f));
}

export function startScheduler(db: DB, ha: Ha, notifier: Notifier, log: Log) {
  const guard = (name: string, fn: () => Promise<void> | void) => async () => {
    if (!ha.isActive()) return;
    try { await fn(); } catch (e) { log.warn({ err: e, job: name }, 'scheduled job failed'); }
  };
  const tasks = [
    cron.schedule('* * * * *', guard('digest', () => runDigests(db, notifier, log))),
    cron.schedule('*/5 * * * *', guard('mesh', () => runMeshAlerts(db, notifier, log))),
    cron.schedule('17 3 * * *', guard('prune', () => prune(db))),
    cron.schedule('41 3 * * *', guard('backup', () => snapshotBackup(db, config.dataDir))),
  ];
  return () => tasks.forEach((t) => t.stop());
}
