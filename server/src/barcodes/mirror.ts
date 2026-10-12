import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import zlib from 'node:zlib';
import Database from 'better-sqlite3';
import cron from 'node-cron';
import { gtinCandidates, offIndex, parseOffLine, parseUsdaLine, type MirrorRow, type OffIndex } from './parse.js';
import { unzipFirstEntry } from './unzip.js';

/**
 * Offline copy of public grocery barcode data in its own SQLite file (data/barcodes.db), so
 * scanning works without internet and the main database, snapshots and standby sync stay small.
 * Each source lives in its own table and is rebuilt into <name>_new then swapped in, so lookups
 * never see a half-imported table.
 */

export const SOURCES = {
  usda: { label: 'USDA FoodData Central (branded foods)', license: 'public domain' },
  off: { label: 'Open Food Facts', license: 'ODbL' },
} as const;
export type Source = keyof typeof SOURCES;

export const USDA_INDEX = 'https://fdc.nal.usda.gov/download-datasets';
export const USDA_BASE = 'https://fdc.nal.usda.gov/fdc-datasets/';
export const OFF_EXPORT = 'https://static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz';
const OFF_MAX_AGE = 30 * 86400000;
const UA = 'Bunkerr/0.1 (self-hosted household inventory; monthly bulk refresh)';

export interface MirrorHit extends Omit<MirrorRow, 'gtin'> { source: string }

export interface SourceStatus {
  source: Source; label: string; license: string;
  version: string | null; rows: number; builtAt: number | null; checkedAt: number | null; error: string | null;
  running: boolean; progress: number;
}
export interface MirrorStatus { enabled: boolean; products: number; sizeMb: number; sources: SourceStatus[] }

export interface Mirror {
  lookup(code: string): MirrorHit | null;
  status(): MirrorStatus;
  /** Refreshes sources that are due (or all, with force). Resolves when done; concurrent calls share the run. */
  refresh(opts?: { sources?: Source[]; force?: boolean }): Promise<void>;
  running(): boolean;
  close(): void;
}

interface Log { info(o: object, m?: string): void; warn(o: object, m?: string): void }
const quiet: Log = { info() {}, warn() {} };

export interface MirrorOptions {
  enabled?: boolean;
  /** Open Food Facts country tags to keep, e.g. ["en:united-states"]; empty keeps the whole world. */
  countries?: string[];
  fetcher?: typeof fetch;
  log?: Log;
  /** Override download locations (tests). */
  urls?: { usdaIndex?: string; usdaBase?: string; off?: string };
}

const COLS = 'gtin TEXT PRIMARY KEY, name TEXT NOT NULL, brand TEXT, quantity TEXT, category TEXT, kcal REAL, image TEXT';

export function openMirror(file: string, opts: MirrorOptions = {}): Mirror {
  const enabled = opts.enabled ?? true;
  const countries = opts.countries ?? ['en:united-states'];
  const fetcher = opts.fetcher ?? fetch;
  const log = opts.log ?? quiet;
  const urls = { usdaIndex: USDA_INDEX, usdaBase: USDA_BASE, off: OFF_EXPORT, ...opts.urls };

  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('auto_vacuum = INCREMENTAL');
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (source TEXT PRIMARY KEY, version TEXT, rows INTEGER NOT NULL DEFAULT 0,
      built_at INTEGER, checked_at INTEGER, error TEXT);
    CREATE TABLE IF NOT EXISTS usda (${COLS}) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS off (${COLS}) WITHOUT ROWID;
    DROP TABLE IF EXISTS usda_new; DROP TABLE IF EXISTS off_new;`);

  const get = {
    usda: db.prepare('SELECT * FROM usda WHERE gtin=?'),
    off: db.prepare('SELECT * FROM off WHERE gtin=?'),
  };
  const metaOf = (s: Source) => db.prepare('SELECT * FROM meta WHERE source=?').get(s) as
    { version: string | null; rows: number; built_at: number | null; checked_at: number | null; error: string | null } | undefined;
  const setMeta = (s: Source, m: Partial<{ version: string | null; rows: number; built_at: number; checked_at: number; error: string | null }>) => {
    db.prepare('INSERT INTO meta (source) VALUES (?) ON CONFLICT(source) DO NOTHING').run(s);
    for (const [k, v] of Object.entries(m)) db.prepare(`UPDATE meta SET ${k}=? WHERE source=?`).run(v, s);
  };

  const state = { current: null as Promise<void> | null, source: null as Source | null, progress: 0, products: null as number | null };
  /** Distinct products across sources; cached because it scans both tables. */
  const products = () => (state.products ??= (db.prepare(
    'SELECT (SELECT COUNT(*) FROM usda) + (SELECT COUNT(*) FROM off WHERE gtin NOT IN (SELECT gtin FROM usda)) AS n').get() as { n: number }).n);

  function lookup(code: string): MirrorHit | null {
    for (const key of gtinCandidates(code)) {
      const u = get.usda.get(key) as MirrorRow | undefined;
      const o = get.off.get(key) as MirrorRow | undefined;
      if (!u && !o) continue;
      // Open Food Facts names are usually typed by people in mixed case and come with a photo;
      // USDA's label data is the better calorie source.
      return {
        name: o?.name ?? u!.name,
        brand: o?.brand ?? u?.brand ?? null,
        quantity: o?.quantity ?? u?.quantity ?? null,
        category: u?.category ?? o!.category,
        kcal: u?.kcal ?? o?.kcal ?? null,
        image: o?.image ?? null,
        source: u && o ? 'usda+off' : u ? 'usda' : 'off',
      };
    }
    return null;
  }

  async function importInto(source: Source, rows: AsyncIterable<MirrorRow>): Promise<number> {
    const tmp = `${source}_new`;
    db.exec(`DROP TABLE IF EXISTS ${tmp}; CREATE TABLE ${tmp} (${COLS}) WITHOUT ROWID;`);
    const ins = db.prepare(`INSERT INTO ${tmp} (gtin,name,brand,quantity,category,kcal,image) VALUES (@gtin,@name,@brand,@quantity,@category,@kcal,@image)
      ON CONFLICT(gtin) DO UPDATE SET name=excluded.name, brand=COALESCE(excluded.brand,brand), quantity=COALESCE(excluded.quantity,quantity),
        category=excluded.category, kcal=COALESCE(excluded.kcal,kcal), image=COALESCE(excluded.image,image)`);
    const flush = db.transaction((batch: MirrorRow[]) => { for (const r of batch) ins.run(r); });
    let batch: MirrorRow[] = [];
    state.progress = 0;
    try {
      for await (const r of rows) {
        batch.push(r);
        if (batch.length >= 5000) {
          flush(batch); state.progress += batch.length; batch = [];
          await new Promise((r) => setImmediate(r)); // let requests through between batches
        }
      }
      flush(batch); state.progress += batch.length;
      const n = (db.prepare(`SELECT COUNT(*) AS n FROM ${tmp}`).get() as { n: number }).n;
      if (n === 0) throw new Error('import produced no products');
      db.transaction(() => { db.exec(`DROP TABLE ${source}; ALTER TABLE ${tmp} RENAME TO ${source};`); })();
      db.pragma('incremental_vacuum');
      state.products = null;
      return n;
    } catch (e) {
      db.exec(`DROP TABLE IF EXISTS ${tmp}`);
      throw e;
    }
  }

  async function download(url: string): Promise<AsyncIterable<Uint8Array>> {
    const res = await fetcher(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(3 * 3600 * 1000) });
    if (!res.ok || !res.body) throw new Error(`GET ${url} → ${res.status}`);
    return Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>);
  }

  /** Pulls one chunk at a time, so a fast download can't pile lines up in memory (readline would). */
  async function* lines(input: Readable): AsyncIterable<string> {
    const dec = new StringDecoder('utf8');
    let rest = '';
    for await (const chunk of input) {
      const parts = (rest + dec.write(chunk as Buffer)).split('\n');
      rest = parts.pop()!;
      yield* parts;
    }
    rest += dec.end();
    if (rest) yield rest;
  }

  async function latestUsda(): Promise<string> {
    const res = await fetcher(urls.usdaIndex, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`USDA download page → ${res.status}`);
    const dates = [...(await res.text()).matchAll(/FoodData_Central_branded_food_json_(\d{4}-\d{2}-\d{2})\.zip/g)].map((m) => m[1]).sort();
    if (!dates.length) throw new Error('no branded food release listed on the USDA download page');
    return dates.at(-1)!;
  }

  async function refreshUsda(force: boolean) {
    const version = await latestUsda();
    const m = metaOf('usda');
    if (!force && m?.version === version && m.rows > 0) return setMeta('usda', { checked_at: Date.now(), error: null });
    const zip = await download(`${urls.usdaBase}FoodData_Central_branded_food_json_${version}.zip`);
    const json = await unzipFirstEntry(zip);
    async function* rows() { for await (const l of lines(json)) { const r = parseUsdaLine(l); if (r) yield r; } }
    const n = await importInto('usda', rows());
    setMeta('usda', { version, rows: n, built_at: Date.now(), checked_at: Date.now(), error: null });
    return undefined;
  }

  async function refreshOff(force: boolean) {
    const m = metaOf('off');
    if (!force && m?.built_at && Date.now() - m.built_at < OFF_MAX_AGE && m.rows > 0) return setMeta('off', { checked_at: Date.now(), error: null });
    const gz = Readable.from(await download(urls.off)).pipe(zlib.createGunzip());
    let idx: OffIndex | null = null;
    async function* rows() {
      for await (const l of lines(gz)) {
        if (!idx) { idx = offIndex(l); continue; }
        const r = parseOffLine(l, idx, countries);
        if (r) yield r;
      }
    }
    const n = await importInto('off', rows());
    setMeta('off', { version: new Date().toISOString().slice(0, 10), rows: n, built_at: Date.now(), checked_at: Date.now(), error: null });
    return undefined;
  }

  async function run(sources: Source[], force: boolean) {
    for (const s of sources) {
      state.source = s;
      const t = Date.now();
      try {
        await (s === 'usda' ? refreshUsda(force) : refreshOff(force));
        const m = metaOf(s);
        log.info({ source: s, rows: m?.rows, version: m?.version, secs: Math.round((Date.now() - t) / 1000) }, 'barcode mirror source checked');
      } catch (e) {
        const msg = (e as Error).message || String(e);
        setMeta(s, { checked_at: Date.now(), error: msg.slice(0, 300) });
        log.warn({ source: s, err: msg }, 'barcode mirror refresh failed');
      }
    }
    state.source = null;
  }

  return {
    lookup,
    refresh({ sources = ['usda', 'off'] as Source[], force = false } = {}) {
      if (!enabled) return Promise.resolve();
      state.current ??= run(sources, force).finally(() => { state.current = null; });
      return state.current;
    },
    running: () => state.current != null,
    status() {
      const sources = (Object.keys(SOURCES) as Source[]).map((s): SourceStatus => {
        const m = metaOf(s);
        return {
          source: s, ...SOURCES[s], version: m?.version ?? null, rows: m?.rows ?? 0, builtAt: m?.built_at ?? null,
          checkedAt: m?.checked_at ?? null, error: m?.error ?? null, running: state.source === s, progress: state.source === s ? state.progress : 0,
        };
      });
      const pages = (db.pragma('page_count', { simple: true }) as number) * (db.pragma('page_size', { simple: true }) as number);
      return { enabled, products: products(), sizeMb: Math.round(pages / 1048576), sources };
    },
    close: () => db.close(),
  };
}

/**
 * Nightly check on every instance (standby included, so a failover still scans offline).
 * USDA is re-imported only when a new release appears; Open Food Facts monthly.
 */
export function startMirrorSchedule(mirror: Mirror, log: Log, expr = '20 2 * * *') {
  const task = cron.schedule(expr, () => { mirror.refresh().catch((e) => log.warn({ err: e }, 'barcode mirror refresh failed')); });
  return () => task.stop();
}
