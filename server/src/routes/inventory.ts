import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';
import { HttpError, requireHousehold } from '../auth.js';
import { touchWrite, type DB } from '../db.js';
import { getSettings } from '../settings.js';
import { expiryTier, idParam, isoDate, parse, todayIn } from '../util.js';

export const CATEGORIES = ['food', 'water', 'medical', 'hygiene', 'power', 'tools', 'comms', 'garden', 'other'] as const;

export const itemInput = z.object({
  name: z.string().trim().min(1).max(120),
  category: z.enum(CATEGORIES).default('food'),
  qty: z.number().min(0).max(1e6).default(1),
  unit: z.string().trim().max(20).default('ea'),
  location: z.string().trim().max(60).default(''),
  barcode: z.string().trim().max(32).nullish(),
  expires_on: isoDate.nullish(),
  opened_on: isoDate.nullish(),
  min_qty: z.number().min(0).max(1e6).nullish(),
  kcal_per_unit: z.number().min(0).max(1e5).nullish(),
  notes: z.string().max(1000).default(''),
});
export type ItemInput = z.infer<typeof itemInput>;

export interface ItemRow extends ItemInput { id: number; household_id: number; created_at: number; updated_at: number }

function logEvent(db: DB, hh: number, itemId: number | null, name: string, kind: string, qty: number | null, userId: number) {
  db.prepare('INSERT INTO item_events (household_id,item_id,item_name,kind,qty,user_id,at) VALUES (?,?,?,?,?,?,?)')
    .run(hh, itemId, name, kind, qty, userId, Date.now());
}

/** Inserts or merges into an identical batch (same name/unit/location/expiry/category). */
export function addItem(db: DB, hh: number, it: ItemInput, userId: number, merge = true): number {
  const t = Date.now();
  if (merge) {
    const existing = db.prepare(`SELECT id FROM items WHERE household_id=? AND name=? COLLATE NOCASE AND unit=? AND location=? AND category=?
      AND COALESCE(expires_on,'')=COALESCE(?,'') LIMIT 1`).get(hh, it.name, it.unit, it.location, it.category, it.expires_on ?? null) as { id: number } | undefined;
    if (existing) {
      db.prepare('UPDATE items SET qty=qty+?, updated_at=?, barcode=COALESCE(barcode,?) WHERE id=? AND household_id=?').run(it.qty, t, it.barcode ?? null, existing.id, hh);
      logEvent(db, hh, existing.id, it.name, 'add', it.qty, userId);
      return existing.id;
    }
  }
  const id = Number(db.prepare(`INSERT INTO items (household_id,name,category,qty,unit,location,barcode,expires_on,opened_on,min_qty,kcal_per_unit,notes,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(hh, it.name, it.category, it.qty, it.unit, it.location, it.barcode ?? null, it.expires_on ?? null,
    it.opened_on ?? null, it.min_qty ?? null, it.kcal_per_unit ?? null, it.notes, t, t).lastInsertRowid);
  logEvent(db, hh, id, it.name, 'add', it.qty, userId);
  return id;
}

export function getItem(db: DB, hh: number, id: number): ItemRow {
  const row = db.prepare('SELECT * FROM items WHERE id=? AND household_id=?').get(id, hh) as ItemRow | undefined;
  if (!row) throw new HttpError(404, 'Item not found');
  return row;
}

/** Total stock per item name, to compare against min_qty across batches. */
export function lowStock(db: DB, hh: number) {
  return db.prepare(`SELECT name, unit, SUM(qty) AS total, MAX(min_qty) AS min_qty FROM items WHERE household_id=?
    GROUP BY name COLLATE NOCASE, unit HAVING MAX(min_qty) IS NOT NULL AND SUM(qty) < MAX(min_qty) ORDER BY name`).all(hh) as
    { name: string; unit: string; total: number; min_qty: number }[];
}

const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export default async function inventoryRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;

  app.get('/api/items', async (req) => {
    const hh = requireHousehold(req);
    const q = parse(z.object({
      q: z.string().optional(), category: z.string().optional(), location: z.string().optional(),
      tier: z.enum(['expired', 'soon', 'upcoming', 'ok', 'none']).optional(),
      sort: z.enum(['expiry', 'name', 'updated', 'category']).default('expiry'),
    }), req.query);
    const s = getSettings(db, hh);
    const today = todayIn(s.timezone);
    const where = ['household_id = ?'];
    const args: unknown[] = [hh];
    if (q.q) { where.push('(name LIKE ? OR notes LIKE ? OR barcode = ?)'); args.push(`%${q.q}%`, `%${q.q}%`, q.q); }
    if (q.category) { where.push('category = ?'); args.push(q.category); }
    if (q.location) { where.push('location = ?'); args.push(q.location); }
    const order = { expiry: 'expires_on IS NULL, expires_on, name', name: 'name COLLATE NOCASE', updated: 'updated_at DESC', category: 'category, name COLLATE NOCASE' }[q.sort];
    const rows = db.prepare(`SELECT * FROM items WHERE ${where.join(' AND ')} ORDER BY ${order}`).all(...args) as ItemRow[];
    const items = rows.map((r) => ({ ...r, tier: expiryTier(r.expires_on, today, s.expirySoonDays, s.expiryUpcomingDays) }));
    // Batches per category for the section tabs, regardless of the current filter.
    const counts = Object.fromEntries((db.prepare('SELECT category, COUNT(*) AS n FROM items WHERE household_id=? GROUP BY category').all(hh) as { category: string; n: number }[]).map((r) => [r.category, r.n]));
    const devices = (db.prepare('SELECT COUNT(*) AS n FROM equipment WHERE household_id=?').get(hh) as { n: number }).n;
    return { today, items: q.tier ? items.filter((i) => i.tier === q.tier) : items, counts, devices };
  });

  app.get('/api/items/meta', async (req) => {
    const hh = requireHousehold(req);
    const col = (c: string) => (db.prepare(`SELECT DISTINCT ${c} AS v FROM items WHERE household_id=? AND ${c}<>'' ORDER BY ${c}`).all(hh) as { v: string }[]).map((r) => r.v);
    const recent = db.prepare(`SELECT name, category, unit, location, MAX(updated_at) AS u, kcal_per_unit, min_qty FROM items WHERE household_id=?
      GROUP BY name COLLATE NOCASE ORDER BY u DESC LIMIT 200`).all(hh);
    return { categories: CATEGORIES, locations: col('location'), units: col('unit'), recent };
  });

  app.post('/api/items', async (req) => {
    const hh = requireHousehold(req, 'member');
    const body = parse(itemInput.extend({ merge: z.boolean().default(true) }), req.body);
    const id = addItem(db, hh, body, req.ctx!.user.id, body.merge);
    touchWrite(db);
    return getItem(db, hh, id);
  });

  app.post('/api/items/bulk', async (req) => {
    const hh = requireHousehold(req, 'member');
    const { items } = parse(z.object({ items: z.array(itemInput).min(1).max(200) }), req.body);
    const ids = db.transaction(() => items.map((it) => addItem(db, hh, it, req.ctx!.user.id)))();
    touchWrite(db);
    return { added: ids.length };
  });

  app.patch('/api/items/:id', async (req) => {
    const hh = requireHousehold(req, 'member');
    const { id } = parse(idParam, req.params);
    const cur = getItem(db, hh, id);
    const patch = parse(itemInput.partial(), req.body);
    const next = { ...cur, ...patch };
    db.prepare(`UPDATE items SET name=?,category=?,qty=?,unit=?,location=?,barcode=?,expires_on=?,opened_on=?,min_qty=?,kcal_per_unit=?,notes=?,updated_at=?
      WHERE id=? AND household_id=?`).run(next.name, next.category, next.qty, next.unit, next.location, next.barcode ?? null, next.expires_on ?? null,
      next.opened_on ?? null, next.min_qty ?? null, next.kcal_per_unit ?? null, next.notes, Date.now(), id, hh);
    logEvent(db, hh, id, next.name, 'edit', null, req.ctx!.user.id);
    touchWrite(db);
    return getItem(db, hh, id);
  });

  /** Use or discard some quantity; the batch is removed when it reaches zero. */
  app.post('/api/items/:id/consume', async (req) => {
    const hh = requireHousehold(req, 'member');
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ qty: z.number().positive(), kind: z.enum(['use', 'discard']).default('use') }), req.body);
    const cur = getItem(db, hh, id);
    const left = Math.max(0, +(cur.qty - body.qty).toFixed(4));
    db.transaction(() => {
      if (left <= 0) db.prepare('DELETE FROM items WHERE id=? AND household_id=?').run(id, hh);
      else db.prepare('UPDATE items SET qty=?, updated_at=? WHERE id=? AND household_id=?').run(left, Date.now(), id, hh);
      logEvent(db, hh, id, cur.name, body.kind, Math.min(body.qty, cur.qty), req.ctx!.user.id);
    })();
    touchWrite(db);
    return { id, qty: left, removed: left <= 0 };
  });

  app.delete('/api/items/:id', async (req) => {
    const hh = requireHousehold(req, 'member');
    const { id } = parse(idParam, req.params);
    const cur = getItem(db, hh, id);
    db.prepare('DELETE FROM items WHERE id=? AND household_id=?').run(id, hh);
    logEvent(db, hh, id, cur.name, 'delete', cur.qty, req.ctx!.user.id);
    touchWrite(db);
    return { ok: true };
  });

  app.get('/api/items/events', async (req) => {
    const hh = requireHousehold(req);
    return db.prepare(`SELECT e.*, u.name AS user_name FROM item_events e LEFT JOIN users u ON u.id=e.user_id
      WHERE e.household_id=? ORDER BY e.at DESC LIMIT 100`).all(hh);
  });

  app.get('/api/items/export.csv', async (req, reply) => {
    const hh = requireHousehold(req);
    const cols = ['name', 'category', 'qty', 'unit', 'location', 'expires_on', 'opened_on', 'min_qty', 'kcal_per_unit', 'barcode', 'notes'] as const;
    const rows = db.prepare('SELECT * FROM items WHERE household_id=? ORDER BY category, name').all(hh) as ItemRow[];
    const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n');
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="bunkerr-inventory.csv"');
    return csv;
  });
}
