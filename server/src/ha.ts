import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { DB } from './db.js';
import type { Config } from './config.js';

/**
 * Active/standby coordination (see docs/04-failover.md).
 *  - primary: active unless the standby reports it has been promoted ("fenced").
 *  - standby: active only while the PROMOTED flag file exists; otherwise it pulls
 *    a snapshot from the primary every few minutes.
 * Only the active instance runs the scheduler, so alerts are never sent twice.
 */
export interface Ha {
  isActive(): boolean;
  status(): { node: string; role: 'primary' | 'standby'; active: boolean; promoted: boolean; peerActive: boolean; lastSyncAt: number | null; lastSyncError: string | null };
  promote(): void;
  demote(): void;
  /** Overwrite the live database from a snapshot file (online, via the SQLite backup API). */
  restoreFrom(snapshotFile: string): Promise<void>;
  /** Write a consistent snapshot of the live database to a file. */
  snapshotTo(file: string): Promise<void>;
  start(log: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void }): void;
  stop(): void;
}

/** Remove a SQLite file and the -wal/-shm sidecars opening it may have created. */
export function rmDbFiles(file: string) {
  for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
}

export function createHa(db: DB, cfg: Config, dbFile: string): Ha {
  const flag = path.join(cfg.dataDir, 'PROMOTED');
  let peerActive = false;
  let lastSyncAt: number | null = null;
  let lastSyncError: string | null = null;
  const timers: NodeJS.Timeout[] = [];

  const promoted = () => cfg.role === 'standby' && fs.existsSync(flag);
  const isActive = () => (cfg.role === 'primary' ? !peerActive : promoted());

  async function restoreFrom(snapshotFile: string) {
    const snap = new Database(snapshotFile, { readonly: true, fileMustExist: true });
    try {
      const ok = snap.pragma('integrity_check', { simple: true });
      if (ok !== 'ok') throw new Error(`snapshot failed integrity check: ${ok}`);
      await snap.backup(dbFile);
    } finally {
      snap.close();
    }
    // Make sure our own connection sees the new pages.
    db.pragma('wal_checkpoint(PASSIVE)');
  }

  async function snapshotTo(file: string) {
    await db.backup(file);
  }

  async function pullSnapshot() {
    if (cfg.role !== 'standby' || promoted() || !cfg.peerUrl || !cfg.internalSecret) return;
    const tmp = path.join(cfg.dataDir, `incoming-${Date.now()}.db`);
    try {
      const res = await fetch(`${cfg.peerUrl}/api/internal/snapshot`, { headers: { 'x-bunkerr-secret': cfg.internalSecret }, signal: AbortSignal.timeout(120000) });
      if (!res.ok) throw new Error(`peer returned ${res.status}`);
      fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
      if (promoted()) return; // promoted while downloading: never overwrite live data
      await restoreFrom(tmp);
      lastSyncAt = Date.now();
      lastSyncError = null;
    } catch (e) {
      lastSyncError = (e as Error).message;
    } finally {
      rmDbFiles(tmp);
    }
  }

  async function checkPeer() {
    if (cfg.role !== 'primary' || !cfg.peerUrl) return;
    try {
      const res = await fetch(`${cfg.peerUrl}/healthz`, { signal: AbortSignal.timeout(5000) });
      const j = await res.json() as { active?: boolean; role?: string };
      peerActive = j.role === 'standby' && j.active === true;
    } catch {
      peerActive = false; // unreachable standby can't be serving
    }
  }

  return {
    isActive,
    status: () => ({ node: cfg.nodeName, role: cfg.role, active: isActive(), promoted: promoted(), peerActive, lastSyncAt, lastSyncError }),
    promote() {
      if (cfg.role !== 'standby') throw new Error('only the standby can be promoted');
      fs.writeFileSync(flag, new Date().toISOString());
    },
    demote() { fs.rmSync(flag, { force: true }); },
    restoreFrom,
    snapshotTo,
    start(log) {
      const syncMin = Number(process.env.SYNC_MINUTES ?? 15);
      if (cfg.role === 'standby') {
        timers.push(setInterval(pullSnapshot, syncMin * 60000));
        setTimeout(pullSnapshot, 5000);
        log.info({ peer: cfg.peerUrl, everyMin: syncMin }, 'standby: snapshot sync enabled');
      } else if (cfg.peerUrl) {
        timers.push(setInterval(checkPeer, 60000));
        void checkPeer();
      }
    },
    stop() { timers.forEach(clearInterval); },
  };
}
