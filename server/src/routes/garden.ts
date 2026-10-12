import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';
import { HttpError, requireHousehold } from '../auth.js';
import { touchWrite, type DB } from '../db.js';
import { inBounds, overlaps, plantingStatus, type Rect } from '../garden-logic.js';
import { getSettings } from '../settings.js';
import { addDays, daysBetween, idParam, isoDate, parse, todayIn } from '../util.js';

interface GardenRow { id: number; household_id: number; name: string; rows: number; cols: number; cell_size_ft: number; notes: string }
interface PlantingRow extends Rect { id: number; garden_id: number; plant_id: number; planted_on: string; last_watered: string | null; harvested_on: string | null; notes: string }
interface PlantRow { id: number; household_id: number | null; name: string; glyph: string; color: string; days_to_germ: number; days_to_maturity: number; water_every_days: number; spacing_in: number; sow: string; notes: string }

const plantInput = z.object({
  name: z.string().trim().min(1).max(60),
  glyph: z.string().trim().min(1).max(3),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  days_to_germ: z.number().int().min(0).max(120),
  days_to_maturity: z.number().int().min(1).max(730),
  water_every_days: z.number().int().min(1).max(60),
  spacing_in: z.number().int().min(1).max(120),
  sow: z.string().max(200).default(''),
  notes: z.string().max(500).default(''),
});

const rect = z.object({ row: z.number().int().min(0), col: z.number().int().min(0), w: z.number().int().min(1).max(50), h: z.number().int().min(1).max(50) });

function getGarden(db: DB, hh: number, id: number): GardenRow {
  const g = db.prepare('SELECT * FROM gardens WHERE id=? AND household_id=?').get(id, hh) as GardenRow | undefined;
  if (!g) throw new HttpError(404, 'Garden not found');
  return g;
}

function getPlanting(db: DB, hh: number, id: number): PlantingRow {
  const p = db.prepare('SELECT * FROM plantings WHERE id=? AND household_id=?').get(id, hh) as PlantingRow | undefined;
  if (!p) throw new HttpError(404, 'Planting not found');
  return p;
}

function getPlant(db: DB, hh: number, id: number): PlantRow {
  const p = db.prepare('SELECT * FROM plants WHERE id=? AND (household_id IS NULL OR household_id=?)').get(id, hh) as PlantRow | undefined;
  if (!p) throw new HttpError(404, 'Plant not found');
  return p;
}

function assertPlacement(db: DB, hh: number, g: GardenRow, r: Rect, ignoreId?: number) {
  if (!inBounds(r, g.rows, g.cols)) throw new HttpError(400, 'Planting is outside the garden grid');
  const others = db.prepare('SELECT id,row,col,w,h FROM plantings WHERE household_id=? AND garden_id=? AND harvested_on IS NULL').all(hh, g.id) as (Rect & { id: number })[];
  if (others.some((o) => o.id !== ignoreId && overlaps(o, r))) throw new HttpError(409, 'That space is already planted');
}

function decorated(db: DB, hh: number, rows: PlantingRow[], today: string) {
  return rows.map((p) => {
    const plant = getPlant(db, hh, p.plant_id);
    return { ...p, plant, status: plantingStatus(p, plant, today) };
  });
}

/** Upcoming garden tasks for a household, used by the UI, the dashboard and the daily digest. */
export function gardenTasks(db: DB, hh: number, today: string, horizonDays = 14) {
  const rows = db.prepare(`SELECT p.*, g.name AS garden_name FROM plantings p JOIN gardens g ON g.id=p.garden_id
    WHERE p.household_id=? AND p.harvested_on IS NULL`).all(hh) as (PlantingRow & { garden_name: string })[];
  const tasks: { kind: 'water' | 'germinate' | 'harvest'; date: string; overdue: number; planting_id: number; garden_id: number; garden: string; plant: string; glyph: string; color: string }[] = [];
  for (const p of rows) {
    const plant = getPlant(db, hh, p.plant_id);
    const s = plantingStatus(p, plant, today);
    const base = { planting_id: p.id, garden_id: p.garden_id, garden: p.garden_name, plant: plant.name, glyph: plant.glyph, color: plant.color };
    const within = (d: string) => daysBetween(today, d) <= horizonDays;
    if (s.next_water && within(s.next_water)) tasks.push({ kind: 'water', date: s.next_water, overdue: Math.max(0, -daysBetween(today, s.next_water)), ...base });
    if (s.stage === 'sown' && within(s.germ_on)) tasks.push({ kind: 'germinate', date: s.germ_on, overdue: 0, ...base });
    if (within(s.harvest_on)) tasks.push({ kind: 'harvest', date: s.harvest_on, overdue: Math.max(0, -daysBetween(today, s.harvest_on)), ...base });
  }
  return tasks.sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind));
}

export default async function gardenRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;
  const today = (hh: number) => todayIn(getSettings(db, hh).timezone);

  app.get('/api/plants', async (req) => {
    const hh = requireHousehold(req);
    return db.prepare('SELECT * FROM plants WHERE household_id IS NULL OR household_id=? ORDER BY name').all(hh);
  });

  app.post('/api/plants', async (req) => {
    const hh = requireHousehold(req, 'member');
    const b = parse(plantInput, req.body);
    const id = db.prepare(`INSERT INTO plants (household_id,name,glyph,color,days_to_germ,days_to_maturity,water_every_days,spacing_in,sow,notes)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(hh, b.name, b.glyph.toUpperCase(), b.color, b.days_to_germ, b.days_to_maturity, b.water_every_days, b.spacing_in, b.sow, b.notes).lastInsertRowid;
    return getPlant(db, hh, Number(id));
  });

  app.patch('/api/plants/:id', async (req) => {
    const hh = requireHousehold(req, 'member');
    const { id } = parse(idParam, req.params);
    const cur = getPlant(db, hh, id);
    if (cur.household_id !== hh) throw new HttpError(403, 'Built-in plants can’t be edited — create a custom copy');
    const b = { ...cur, ...parse(plantInput.partial(), req.body) };
    db.prepare(`UPDATE plants SET name=?,glyph=?,color=?,days_to_germ=?,days_to_maturity=?,water_every_days=?,spacing_in=?,sow=?,notes=? WHERE id=? AND household_id=?`)
      .run(b.name, b.glyph.toUpperCase(), b.color, b.days_to_germ, b.days_to_maturity, b.water_every_days, b.spacing_in, b.sow, b.notes, id, hh);
    return getPlant(db, hh, id);
  });

  app.get('/api/gardens', async (req) => {
    const hh = requireHousehold(req);
    return db.prepare(`SELECT g.*, (SELECT COUNT(*) FROM plantings p WHERE p.garden_id=g.id AND p.harvested_on IS NULL) AS active
      FROM gardens g WHERE g.household_id=? ORDER BY g.name`).all(hh);
  });

  app.post('/api/gardens', async (req) => {
    const hh = requireHousehold(req, 'member');
    const b = parse(z.object({
      name: z.string().trim().min(1).max(60), rows: z.number().int().min(1).max(60), cols: z.number().int().min(1).max(60),
      cell_size_ft: z.number().min(0.25).max(10).default(1), notes: z.string().max(1000).default(''),
    }), req.body);
    const id = db.prepare('INSERT INTO gardens (household_id,name,rows,cols,cell_size_ft,notes,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(hh, b.name, b.rows, b.cols, b.cell_size_ft, b.notes, Date.now()).lastInsertRowid;
    touchWrite(db);
    return getGarden(db, hh, Number(id));
  });

  app.get('/api/gardens/:id', async (req) => {
    const hh = requireHousehold(req);
    const { id } = parse(idParam, req.params);
    const garden = getGarden(db, hh, id);
    const t = today(hh);
    const rows = db.prepare('SELECT * FROM plantings WHERE household_id=? AND garden_id=? ORDER BY harvested_on IS NOT NULL, planted_on DESC').all(hh, id) as PlantingRow[];
    return { today: t, garden, plantings: decorated(db, hh, rows, t) };
  });

  app.patch('/api/gardens/:id', async (req) => {
    const hh = requireHousehold(req, 'member');
    const { id } = parse(idParam, req.params);
    const g = getGarden(db, hh, id);
    const b = { ...g, ...parse(z.object({
      name: z.string().trim().min(1).max(60), rows: z.number().int().min(1).max(60), cols: z.number().int().min(1).max(60),
      cell_size_ft: z.number().min(0.25).max(10), notes: z.string().max(1000),
    }).partial(), req.body) };
    const active = db.prepare('SELECT row,col,w,h FROM plantings WHERE household_id=? AND garden_id=? AND harvested_on IS NULL').all(hh, id) as Rect[];
    if (active.some((r) => !inBounds(r, b.rows, b.cols))) throw new HttpError(409, 'Shrinking would cut off existing plantings — move them first');
    db.prepare('UPDATE gardens SET name=?,rows=?,cols=?,cell_size_ft=?,notes=? WHERE id=? AND household_id=?').run(b.name, b.rows, b.cols, b.cell_size_ft, b.notes, id, hh);
    touchWrite(db);
    return getGarden(db, hh, id);
  });

  app.delete('/api/gardens/:id', async (req) => {
    const hh = requireHousehold(req, 'member');
    const { id } = parse(idParam, req.params);
    getGarden(db, hh, id);
    db.prepare('DELETE FROM gardens WHERE id=? AND household_id=?').run(id, hh);
    touchWrite(db);
    return { ok: true };
  });

  app.post('/api/gardens/:id/plantings', async (req) => {
    const hh = requireHousehold(req, 'member');
    const { id } = parse(idParam, req.params);
    const g = getGarden(db, hh, id);
    const b = parse(rect.extend({ plant_id: z.number().int(), planted_on: isoDate.optional(), notes: z.string().max(500).default('') }), req.body);
    getPlant(db, hh, b.plant_id);
    assertPlacement(db, hh, g, b);
    const planted = b.planted_on ?? today(hh);
    const pid = db.prepare(`INSERT INTO plantings (household_id,garden_id,plant_id,row,col,w,h,planted_on,last_watered,notes) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(hh, id, b.plant_id, b.row, b.col, b.w, b.h, planted, planted, b.notes).lastInsertRowid;
    touchWrite(db);
    return decorated(db, hh, [getPlanting(db, hh, Number(pid))], today(hh))[0];
  });

  app.patch('/api/plantings/:id', async (req) => {
    const hh = requireHousehold(req, 'member');
    const { id } = parse(idParam, req.params);
    const cur = getPlanting(db, hh, id);
    const patch = parse(rect.partial().extend({
      plant_id: z.number().int().optional(), planted_on: isoDate.optional(), last_watered: isoDate.nullish(),
      harvested_on: isoDate.nullish(), notes: z.string().max(500).optional(),
    }), req.body);
    const next = { ...cur, ...patch };
    if (patch.plant_id) getPlant(db, hh, patch.plant_id);
    if (!next.harvested_on) assertPlacement(db, hh, getGarden(db, hh, cur.garden_id), next, id);
    db.prepare('UPDATE plantings SET plant_id=?,row=?,col=?,w=?,h=?,planted_on=?,last_watered=?,harvested_on=?,notes=? WHERE id=? AND household_id=?')
      .run(next.plant_id, next.row, next.col, next.w, next.h, next.planted_on, next.last_watered ?? null, next.harvested_on ?? null, next.notes, id, hh);
    touchWrite(db);
    return decorated(db, hh, [getPlanting(db, hh, id)], today(hh))[0];
  });

  app.delete('/api/plantings/:id', async (req) => {
    const hh = requireHousehold(req, 'member');
    const { id } = parse(idParam, req.params);
    getPlanting(db, hh, id);
    db.prepare('DELETE FROM plantings WHERE id=? AND household_id=?').run(id, hh);
    touchWrite(db);
    return { ok: true };
  });

  /** Mark watered: a single planting, or every active planting in a garden. "skip" = it rained. */
  app.post('/api/gardens/:id/water', async (req) => {
    const hh = requireHousehold(req, 'member');
    const { id } = parse(idParam, req.params);
    getGarden(db, hh, id);
    const b = parse(z.object({ plantingIds: z.array(z.number().int()).optional() }), req.body ?? {});
    const t = today(hh);
    const r = b.plantingIds?.length
      ? db.prepare(`UPDATE plantings SET last_watered=? WHERE household_id=? AND garden_id=? AND harvested_on IS NULL AND id IN (${b.plantingIds.map(() => '?').join(',')})`)
        .run(t, hh, id, ...b.plantingIds)
      : db.prepare('UPDATE plantings SET last_watered=? WHERE household_id=? AND garden_id=? AND harvested_on IS NULL').run(t, hh, id);
    touchWrite(db);
    return { watered: r.changes };
  });

  app.get('/api/garden/tasks', async (req) => {
    const hh = requireHousehold(req);
    const { days } = parse(z.object({ days: z.coerce.number().int().min(1).max(120).default(14) }), req.query);
    const t = today(hh);
    return { today: t, until: addDays(t, days), tasks: gardenTasks(db, hh, t, days) };
  });
}
