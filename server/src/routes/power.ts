import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';
import { HttpError, requireHousehold } from '../auth.js';
import { touchWrite, type DB } from '../db.js';
import { getSettings } from '../settings.js';
import { addDays, daysBetween, idParam, isoDate, parse, todayIn } from '../util.js';

/**
 * Power equipment: power banks, power stations, UPS battery backups, generators, solar and
 * battery banks, each with one or more upkeep reminders ("top up charge", "run under load").
 * Lithium packs self-discharge and generators gum up when they sit, so the reminder is the
 * point. A reminder's next date is set by hand, suggested as last done + its interval
 * (3 months unless changed).
 */

export const EQUIPMENT_KINDS = ['power_bank', 'power_station', 'ups', 'generator', 'solar', 'battery', 'other'] as const;
export type EquipmentKind = (typeof EQUIPMENT_KINDS)[number];
export const DEFAULT_EVERY_DAYS = 90;
export const DUE_SOON_DAYS = 7;

/** First entry is the reminder a new device gets; the rest are offered as one-tap extras. */
export const TASK_SUGGESTIONS: Record<EquipmentKind, { label: string; every_days: number }[]> = {
  power_bank: [{ label: 'Top up charge', every_days: 90 }],
  power_station: [{ label: 'Charge to 80% and test outlets', every_days: 90 }, { label: 'Full discharge / recharge cycle', every_days: 180 }],
  ups: [{ label: 'Run self-test and check battery', every_days: 90 }, { label: 'Replace battery', every_days: 1095 }],
  generator: [{ label: 'Run under load 20–30 min', every_days: 90 }, { label: 'Fresh fuel / add stabilizer', every_days: 180 }, { label: 'Change oil', every_days: 365 }, { label: 'Check spark plug & air filter', every_days: 365 }],
  solar: [{ label: 'Clean panels and check cables', every_days: 90 }],
  battery: [{ label: 'Check voltage and top up charge', every_days: 90 }],
  other: [{ label: 'Check and maintain', every_days: 90 }],
};

const str = (max: number) => z.string().trim().max(max);
const equipmentInput = z.object({
  name: str(80).min(1),
  kind: z.enum(EQUIPMENT_KINDS).default('power_bank'),
  brand: str(60).default(''),
  model: str(80).default(''),
  capacity_wh: z.number().min(0).max(1e6).nullish(),
  capacity_mah: z.number().min(0).max(1e7).nullish(),
  output_w: z.number().min(0).max(1e6).nullish(),
  fuel: str(30).default(''),
  location: str(60).default(''),
  serial: str(60).default(''),
  purchased_on: isoDate.nullish(),
  charge_pct: z.number().int().min(0).max(100).nullish(),
  run_hours: z.number().min(0).max(1e6).nullish(),
  notes: str(2000).default(''),
});
const taskInput = z.object({
  label: str(80).min(1),
  every_days: z.number().int().min(1).max(3650).default(DEFAULT_EVERY_DAYS),
  last_done_on: isoDate.nullish(),
  /** Manual override; when missing it's last done (or today) + every_days. */
  next_due_on: isoDate.nullish(),
  notes: str(500).default(''),
});
const doneInput = z.object({
  done_on: isoDate.optional(),
  charge_pct: z.number().int().min(0).max(100).nullish(),
  run_hours: z.number().min(0).max(1e6).nullish(),
  note: str(500).default(''),
});

interface TaskRow { id: number; equipment_id: number; label: string; every_days: number; last_done_on: string | null; next_due_on: string; notes: string }
interface EquipmentRow { id: number; name: string; kind: string; [k: string]: unknown }

function taskState<T extends TaskRow>(t: T, today: string): T & { days_until: number; state: 'due' | 'soon' | 'ok' } {
  const days = daysBetween(today, t.next_due_on);
  return { ...t, days_until: days, state: days <= 0 ? 'due' : days <= DUE_SOON_DAYS ? 'soon' : 'ok' };
}

export function powerSummary(db: DB, hh: number, today: string) {
  const tasks = db.prepare(`SELECT t.*, e.name AS equipment_name, e.location FROM equipment_tasks t JOIN equipment e ON e.id=t.equipment_id
    WHERE t.household_id=? AND t.next_due_on <= ? ORDER BY t.next_due_on`).all(hh, addDays(today, DUE_SOON_DAYS)) as (TaskRow & { equipment_name: string; location: string })[];
  const count = (db.prepare('SELECT COUNT(*) AS n FROM equipment WHERE household_id=?').get(hh) as { n: number }).n;
  const withState = tasks.map((t) => taskState(t, today));
  return { count, due: withState.filter((t) => t.state === 'due'), soon: withState.filter((t) => t.state === 'soon') };
}

export default async function powerRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;
  const today = (hh: number) => todayIn(getSettings(db, hh).timezone);
  const own = (hh: number, id: number) => {
    const e = db.prepare('SELECT * FROM equipment WHERE id=? AND household_id=?').get(id, hh) as EquipmentRow | undefined;
    if (!e) throw new HttpError(404, 'Not found');
    return e;
  };
  const ownTask = (hh: number, id: number) => {
    const t = db.prepare('SELECT * FROM equipment_tasks WHERE id=? AND household_id=?').get(id, hh) as TaskRow | undefined;
    if (!t) throw new HttpError(404, 'Not found');
    return t;
  };
  const insertTask = (hh: number, equipmentId: number, t: z.infer<typeof taskInput>, td: string) => {
    const next = t.next_due_on ?? addDays(t.last_done_on ?? td, t.every_days);
    return Number(db.prepare(`INSERT INTO equipment_tasks (household_id,equipment_id,label,every_days,last_done_on,next_due_on,notes,created_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(hh, equipmentId, t.label, t.every_days, t.last_done_on ?? null, next, t.notes, Date.now()).lastInsertRowid);
  };

  app.get('/api/power', async (req) => {
    const hh = requireHousehold(req);
    const td = today(hh);
    const equipment = db.prepare('SELECT * FROM equipment WHERE household_id=? ORDER BY name COLLATE NOCASE').all(hh) as EquipmentRow[];
    const tasks = (db.prepare('SELECT * FROM equipment_tasks WHERE household_id=? ORDER BY next_due_on').all(hh) as TaskRow[]).map((t) => taskState(t, td));
    const lastLog = db.prepare(`SELECT equipment_id, MAX(done_on) AS done_on FROM equipment_log WHERE household_id=? GROUP BY equipment_id`).all(hh) as { equipment_id: number; done_on: string }[];
    const last = new Map(lastLog.map((l) => [l.equipment_id, l.done_on]));
    return {
      today: td,
      summary: powerSummary(db, hh, td),
      equipment: equipment.map((e) => ({ ...e, tasks: tasks.filter((t) => t.equipment_id === e.id), last_done_on: last.get(e.id) ?? null })),
      options: { kinds: EQUIPMENT_KINDS, suggestions: TASK_SUGGESTIONS, defaultEveryDays: DEFAULT_EVERY_DAYS },
    };
  });

  app.post('/api/power', async (req) => {
    const hh = requireHousehold(req, 'member');
    const body = parse(equipmentInput.extend({ tasks: z.array(taskInput).max(10).optional() }), req.body);
    const td = today(hh);
    const t = Date.now();
    const id = db.transaction(() => {
      const id = Number(db.prepare(`INSERT INTO equipment (household_id,name,kind,brand,model,capacity_wh,capacity_mah,output_w,fuel,location,serial,purchased_on,charge_pct,run_hours,notes,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(hh, body.name, body.kind, body.brand, body.model, body.capacity_wh ?? null, body.capacity_mah ?? null, body.output_w ?? null,
        body.fuel, body.location, body.serial, body.purchased_on ?? null, body.charge_pct ?? null, body.run_hours ?? null, body.notes, t, t).lastInsertRowid);
      // No reminders given: start with the kind's suggested one, due 3 months from today.
      const tasks = body.tasks ?? [taskInput.parse(TASK_SUGGESTIONS[body.kind][0])];
      for (const task of tasks) insertTask(hh, id, task, td);
      touchWrite(db);
      return id;
    })();
    return { id };
  });

  app.patch('/api/power/:id', async (req) => {
    const hh = requireHousehold(req, 'member');
    const { id } = parse(idParam, req.params);
    own(hh, id);
    const b = parse(equipmentInput, req.body);
    db.prepare(`UPDATE equipment SET name=?,kind=?,brand=?,model=?,capacity_wh=?,capacity_mah=?,output_w=?,fuel=?,location=?,serial=?,purchased_on=?,charge_pct=?,run_hours=?,notes=?,updated_at=?
      WHERE id=? AND household_id=?`).run(b.name, b.kind, b.brand, b.model, b.capacity_wh ?? null, b.capacity_mah ?? null, b.output_w ?? null, b.fuel, b.location, b.serial,
      b.purchased_on ?? null, b.charge_pct ?? null, b.run_hours ?? null, b.notes, Date.now(), id, hh);
    touchWrite(db);
    return { ok: true };
  });

  app.delete('/api/power/:id', async (req) => {
    const hh = requireHousehold(req, 'member');
    const { id } = parse(idParam, req.params);
    own(hh, id);
    db.prepare('DELETE FROM equipment WHERE id=? AND household_id=?').run(id, hh);
    touchWrite(db);
    return { ok: true };
  });

  app.get('/api/power/:id/log', async (req) => {
    const hh = requireHousehold(req);
    const { id } = parse(idParam, req.params);
    own(hh, id);
    return db.prepare('SELECT id, task_label, done_on, charge_pct, run_hours, note FROM equipment_log WHERE equipment_id=? AND household_id=? ORDER BY done_on DESC, id DESC LIMIT 50').all(id, hh);
  });

  // ---------------- reminders ----------------
  app.post('/api/power/:id/tasks', async (req) => {
    const hh = requireHousehold(req, 'member');
    const { id } = parse(idParam, req.params);
    own(hh, id);
    const tid = insertTask(hh, id, parse(taskInput, req.body), today(hh));
    touchWrite(db);
    return { id: tid };
  });

  app.patch('/api/power/tasks/:id', async (req) => {
    const hh = requireHousehold(req, 'member');
    const { id } = parse(idParam, req.params);
    const cur = ownTask(hh, id);
    const b = parse(taskInput, req.body);
    // Changing the interval without picking a date re-suggests the date from the last time it was done.
    const next = b.next_due_on ?? (b.every_days !== cur.every_days ? addDays(b.last_done_on ?? cur.last_done_on ?? today(hh), b.every_days) : cur.next_due_on);
    db.prepare('UPDATE equipment_tasks SET label=?, every_days=?, last_done_on=?, next_due_on=?, notes=? WHERE id=? AND household_id=?')
      .run(b.label, b.every_days, b.last_done_on === undefined ? cur.last_done_on : b.last_done_on, next, b.notes, id, hh);
    touchWrite(db);
    return { ok: true, next_due_on: next };
  });

  app.delete('/api/power/tasks/:id', async (req) => {
    const hh = requireHousehold(req, 'member');
    const { id } = parse(idParam, req.params);
    ownTask(hh, id);
    db.prepare('DELETE FROM equipment_tasks WHERE id=? AND household_id=?').run(id, hh);
    touchWrite(db);
    return { ok: true };
  });

  /** Marks a reminder done: logs it, records charge / run hours, and schedules the next one. */
  app.post('/api/power/tasks/:id/done', async (req) => {
    const ctx = req.ctx!;
    const hh = requireHousehold(req, 'member');
    const { id } = parse(idParam, req.params);
    const task = ownTask(hh, id);
    const b = parse(doneInput, req.body ?? {});
    const td = today(hh);
    const doneOn = b.done_on ?? td;
    if (doneOn > td) throw new HttpError(400, 'done_on: can’t be in the future');
    const next = addDays(doneOn, task.every_days);
    db.transaction(() => {
      db.prepare('UPDATE equipment_tasks SET last_done_on=?, next_due_on=? WHERE id=?').run(doneOn, next, id);
      if (b.charge_pct != null) db.prepare('UPDATE equipment SET charge_pct=?, updated_at=? WHERE id=?').run(b.charge_pct, Date.now(), task.equipment_id);
      if (b.run_hours != null) db.prepare('UPDATE equipment SET run_hours=?, updated_at=? WHERE id=?').run(b.run_hours, Date.now(), task.equipment_id);
      db.prepare(`INSERT INTO equipment_log (household_id,equipment_id,task_id,task_label,done_on,charge_pct,run_hours,note,user_id,at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(hh, task.equipment_id, id, task.label, doneOn, b.charge_pct ?? null, b.run_hours ?? null, b.note, ctx.user.id, Date.now());
      touchWrite(db);
    })();
    return { ok: true, last_done_on: doneOn, next_due_on: next };
  });
}
