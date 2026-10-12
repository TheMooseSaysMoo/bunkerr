import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppDeps } from '../app.js';
import { HttpError, requireHousehold, type Role } from '../auth.js';
import { touchWrite, type DB } from '../db.js';
import { CALIBERS, caliberKey, caliberLabel, chamberAccepts } from '../calibers.js';
import { getSettings } from '../settings.js';
import { idParam, isoDate, parse, todayIn, parsePatch } from '../util.js';

export const FIREARM_TYPES = ['handgun', 'rifle', 'shotgun', 'pcc', 'other'] as const;
export const PART_CATEGORIES = ['optic', 'light', 'laser', 'sling', 'trigger', 'stock', 'brace', 'barrel', 'muzzle', 'suppressor', 'handguard', 'grip', 'magazine', 'holster', 'case', 'cleaning', 'other'] as const;
export const AMMO_PURPOSES = ['range', 'defense', 'hunting', 'other'] as const;

const str = (max: number) => z.string().trim().max(max);
const firearmInput = z.object({
  name: str(60).default(''),
  make: str(60).min(1),
  model: str(80).min(1),
  variant: str(80).default(''),
  type: z.enum(FIREARM_TYPES).default('rifle'),
  action: str(30).default(''),
  caliber: str(40).min(1),
  barrel_in: z.number().min(0).max(60).nullish(),
  capacity: z.number().int().min(0).max(200).nullish(),
  serial: str(60).default(''),
  acquired_on: isoDate.nullish(),
  price: z.number().min(0).max(1e6).nullish(),
  condition: str(30).default(''),
  location: str(60).default(''),
  round_count: z.number().int().min(0).max(1e7).default(0),
  clean_every: z.number().int().min(1).max(1e5).nullish(),
  status: z.enum(['active', 'stored', 'sold', 'transferred']).default('active'),
  notes: str(2000).default(''),
});
const partInput = z.object({
  firearm_id: z.number().int().nullish(),
  category: z.enum(PART_CATEGORIES).default('other'),
  make: str(60).default(''),
  model: str(80).min(1),
  qty: z.number().int().min(1).max(1000).default(1),
  serial: str(60).default(''),
  installed_on: isoDate.nullish(),
  price: z.number().min(0).max(1e6).nullish(),
  notes: str(1000).default(''),
});
const ammoInput = z.object({
  caliber: str(40).min(1),
  brand: str(60).default(''),
  line: str(80).default(''),
  grain: z.number().min(0).max(2000).nullish(),
  bullet: str(30).default(''),
  purpose: z.enum(AMMO_PURPOSES).default('range'),
  rounds: z.number().int().min(0).max(1e7).default(0),
  min_rounds: z.number().int().min(0).max(1e7).nullish(),
  location: str(60).default(''),
  barcode: z.string().trim().regex(/^\d{6,14}$/).nullish(),
  lot: str(40).default(''),
  price_per_round: z.number().min(0).max(1000).nullish(),
  notes: str(1000).default(''),
});

interface FirearmRow { id: number; name: string; make: string; model: string; variant: string; type: string; caliber: string; serial: string; round_count: number; rounds_at_clean: number; clean_every: number | null; last_cleaned: string | null; status: string; price: number | null; [k: string]: unknown }
interface AmmoRow { id: number; caliber: string; brand: string; line: string; grain: number | null; bullet: string; purpose: string; rounds: number; min_rounds: number | null; [k: string]: unknown }

export const maskSerial = (s: string) => (!s ? '' : s.length <= 4 ? '••••' : `••••${s.slice(-4)}`);
export const firearmLabel = (f: Pick<FirearmRow, 'name' | 'make' | 'model' | 'variant'>) =>
  f.name || [f.make, f.model, f.variant].filter(Boolean).join(' ');
const ammoLabel = (a: Pick<AmmoRow, 'caliber' | 'brand' | 'line' | 'grain' | 'bullet'>) =>
  [caliberLabel(a.caliber), a.brand, a.line, a.grain ? `${a.grain}gr` : '', a.bullet].filter(Boolean).join(' ');
const cleaningDue = (f: FirearmRow) => f.clean_every != null && f.round_count - f.rounds_at_clean >= f.clean_every;

/** Household armory overview, shared by the API, dashboard and digest. */
export function armorySummary(db: DB, hh: number) {
  const ammo = db.prepare('SELECT * FROM ammo WHERE household_id=?').all(hh) as AmmoRow[];
  const byCaliber = new Map<string, { key: string; label: string; rounds: number; min: number | null; lots: number }>();
  for (const a of ammo) {
    const key = caliberKey(a.caliber);
    const cur = byCaliber.get(key) ?? { key, label: caliberLabel(a.caliber), rounds: 0, min: null, lots: 0 };
    cur.rounds += a.rounds;
    cur.lots++;
    if (a.min_rounds != null) cur.min = Math.max(cur.min ?? 0, a.min_rounds);
    byCaliber.set(key, cur);
  }
  const calibers = [...byCaliber.values()].sort((x, y) => y.rounds - x.rounds);
  const firearms = db.prepare(`SELECT * FROM firearms WHERE household_id=? AND status IN ('active','stored')`).all(hh) as FirearmRow[];
  return {
    calibers,
    lowAmmo: calibers.filter((c) => c.min != null && c.rounds < c.min),
    cleaningDue: firearms.filter(cleaningDue).map((f) => ({ id: f.id, label: firearmLabel(f), since: f.round_count - f.rounds_at_clean, every: f.clean_every })),
    firearmCount: firearms.length,
    totalRounds: calibers.reduce((s, c) => s + c.rounds, 0),
  };
}

export default async function armoryRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;

  /** Viewers only see the armory when the household opts in. */
  const requireArmory = (req: FastifyRequest, min: Role = 'viewer') => {
    const hh = requireHousehold(req, min);
    const s = getSettings(db, hh);
    if (!s.armoryEnabled) throw new HttpError(403, 'The armory is turned off for this household (Settings → armory)');
    if (req.ctx!.role === 'viewer' && !s.armoryViewers) throw new HttpError(403, 'The armory is hidden from viewer accounts');
    return hh;
  };
  const isViewer = (req: FastifyRequest) => req.ctx!.role === 'viewer';

  const getFirearm = (hh: number, id: number) => {
    const f = db.prepare('SELECT * FROM firearms WHERE id=? AND household_id=?').get(id, hh) as FirearmRow | undefined;
    if (!f) throw new HttpError(404, 'Firearm not found');
    return f;
  };
  const getAmmo = (hh: number, id: number) => {
    const a = db.prepare('SELECT * FROM ammo WHERE id=? AND household_id=?').get(id, hh) as AmmoRow | undefined;
    if (!a) throw new HttpError(404, 'Ammo lot not found');
    return a;
  };
  const assertFirearmRef = (hh: number, id: number | null | undefined) => { if (id != null) getFirearm(hh, id); };
  const decorateFirearm = (f: FirearmRow, reveal: boolean) => ({
    ...f, serial: reveal ? f.serial : maskSerial(f.serial), serial_masked: maskSerial(f.serial),
    label: firearmLabel(f), caliber_label: caliberLabel(f.caliber), caliber_key: caliberKey(f.caliber),
    accepts: chamberAccepts(f.caliber), cleaning_due: cleaningDue(f),
    rounds_since_clean: f.round_count - f.rounds_at_clean,
  });
  const decorateAmmo = (a: AmmoRow) => ({ ...a, caliber_key: caliberKey(a.caliber), caliber_label: caliberLabel(a.caliber), label: ammoLabel(a) });

  app.get('/api/armory', async (req) => {
    const hh = requireArmory(req);
    const firearms = (db.prepare(`SELECT f.*, (SELECT COUNT(*) FROM firearm_parts p WHERE p.firearm_id=f.id) AS part_count FROM firearms f
      WHERE f.household_id=? ORDER BY f.status='sold' OR f.status='transferred', f.type, f.make, f.model`).all(hh) as FirearmRow[]).map((f) => decorateFirearm(f, false));
    const ammo = (db.prepare('SELECT * FROM ammo WHERE household_id=? ORDER BY caliber, brand').all(hh) as AmmoRow[]).map(decorateAmmo);
    const parts = db.prepare(`SELECT p.*, f.make || ' ' || f.model AS firearm_label FROM firearm_parts p LEFT JOIN firearms f ON f.id=p.firearm_id
      WHERE p.household_id=? ORDER BY p.firearm_id IS NOT NULL, p.category, p.model`).all(hh) as { serial: string }[];
    const sessions = db.prepare('SELECT * FROM range_sessions WHERE household_id=? ORDER BY on_date DESC, id DESC LIMIT 100').all(hh);
    return {
      today: todayIn(getSettings(db, hh).timezone),
      summary: armorySummary(db, hh),
      firearms, ammo,
      parts: parts.map((p) => ({ ...p, serial: maskSerial(p.serial) })),
      sessions,
      options: { calibers: CALIBERS.map((c) => ({ key: c.key, label: c.label, kind: c.kind })), types: FIREARM_TYPES, partCategories: PART_CATEGORIES, purposes: AMMO_PURPOSES },
    };
  });

  // ---------- firearms ----------
  app.get('/api/armory/firearms/:id', async (req) => {
    const hh = requireArmory(req);
    const { id } = parse(idParam, req.params);
    const f = getFirearm(hh, id);
    const reveal = !isViewer(req);
    const accepts = chamberAccepts(f.caliber);
    const ammo = (db.prepare('SELECT * FROM ammo WHERE household_id=?').all(hh) as AmmoRow[]).filter((a) => accepts.includes(caliberKey(a.caliber))).map(decorateAmmo);
    const parts = (db.prepare('SELECT * FROM firearm_parts WHERE household_id=? AND firearm_id=? ORDER BY category, model').all(hh, id) as { serial: string }[])
      .map((p) => ({ ...p, serial: reveal ? p.serial : maskSerial(p.serial) }));
    const sessions = db.prepare('SELECT * FROM range_sessions WHERE household_id=? AND firearm_id=? ORDER BY on_date DESC, id DESC LIMIT 50').all(hh, id);
    return {
      firearm: decorateFirearm(f, reveal), parts, ammo, sessions,
      accepts: accepts.map((k) => CALIBERS.find((c) => c.key === k)?.label ?? k),
    };
  });

  app.post('/api/armory/firearms', async (req) => {
    const hh = requireArmory(req, 'member');
    const b = parse(firearmInput, req.body);
    const t = Date.now();
    const id = Number(db.prepare(`INSERT INTO firearms (household_id,name,make,model,variant,type,action,caliber,barrel_in,capacity,serial,acquired_on,price,condition,location,round_count,rounds_at_clean,clean_every,status,notes,created_at,updated_at)
      VALUES (@hh,@name,@make,@model,@variant,@type,@action,@caliber,@barrel_in,@capacity,@serial,@acquired_on,@price,@condition,@location,@round_count,@round_count,@clean_every,@status,@notes,@t,@t)`)
      .run({ ...b, barrel_in: b.barrel_in ?? null, capacity: b.capacity ?? null, acquired_on: b.acquired_on ?? null, price: b.price ?? null, clean_every: b.clean_every ?? null, hh, t }).lastInsertRowid);
    touchWrite(db);
    return decorateFirearm(getFirearm(hh, id), true);
  });

  app.patch('/api/armory/firearms/:id', async (req) => {
    const hh = requireArmory(req, 'member');
    const { id } = parse(idParam, req.params);
    const cur = getFirearm(hh, id);
    const n = { ...cur, ...parsePatch(firearmInput, req.body) };
    db.prepare(`UPDATE firearms SET name=@name,make=@make,model=@model,variant=@variant,type=@type,action=@action,caliber=@caliber,barrel_in=@barrel_in,capacity=@capacity,
      serial=@serial,acquired_on=@acquired_on,price=@price,condition=@condition,location=@location,round_count=@round_count,clean_every=@clean_every,status=@status,notes=@notes,updated_at=@t
      WHERE id=@id AND household_id=@hh`).run({ ...n, barrel_in: n.barrel_in ?? null, capacity: n.capacity ?? null, acquired_on: n.acquired_on ?? null, price: n.price ?? null, clean_every: n.clean_every ?? null, t: Date.now(), id, hh });
    touchWrite(db);
    return decorateFirearm(getFirearm(hh, id), true);
  });

  app.post('/api/armory/firearms/:id/cleaned', async (req) => {
    const hh = requireArmory(req, 'member');
    const { id } = parse(idParam, req.params);
    getFirearm(hh, id);
    db.prepare('UPDATE firearms SET last_cleaned=?, rounds_at_clean=round_count, updated_at=? WHERE id=? AND household_id=?').run(todayIn(getSettings(db, hh).timezone), Date.now(), id, hh);
    touchWrite(db);
    return decorateFirearm(getFirearm(hh, id), true);
  });

  app.delete('/api/armory/firearms/:id', async (req) => {
    const hh = requireArmory(req, 'member');
    const { id } = parse(idParam, req.params);
    getFirearm(hh, id);
    db.prepare('DELETE FROM firearms WHERE id=? AND household_id=?').run(id, hh); // parts become spares; sessions keep their label
    touchWrite(db);
    return { ok: true };
  });

  // ---------- parts (modifications & accessories) ----------
  app.post('/api/armory/parts', async (req) => {
    const hh = requireArmory(req, 'member');
    const b = parse(partInput, req.body);
    assertFirearmRef(hh, b.firearm_id);
    const t = Date.now();
    const id = db.prepare(`INSERT INTO firearm_parts (household_id,firearm_id,category,make,model,qty,serial,installed_on,price,notes,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(hh, b.firearm_id ?? null, b.category, b.make, b.model, b.qty, b.serial, b.installed_on ?? null, b.price ?? null, b.notes, t, t).lastInsertRowid;
    touchWrite(db);
    return db.prepare('SELECT * FROM firearm_parts WHERE id=?').get(id);
  });

  app.patch('/api/armory/parts/:id', async (req) => {
    const hh = requireArmory(req, 'member');
    const { id } = parse(idParam, req.params);
    const cur = db.prepare('SELECT * FROM firearm_parts WHERE id=? AND household_id=?').get(id, hh) as z.infer<typeof partInput> | undefined;
    if (!cur) throw new HttpError(404, 'Part not found');
    const patch = parsePatch(partInput, req.body);
    if ('firearm_id' in patch) assertFirearmRef(hh, patch.firearm_id);
    const n = { ...cur, ...patch };
    db.prepare('UPDATE firearm_parts SET firearm_id=?,category=?,make=?,model=?,qty=?,serial=?,installed_on=?,price=?,notes=?,updated_at=? WHERE id=? AND household_id=?')
      .run(n.firearm_id ?? null, n.category, n.make, n.model, n.qty, n.serial, n.installed_on ?? null, n.price ?? null, n.notes, Date.now(), id, hh);
    touchWrite(db);
    return db.prepare('SELECT * FROM firearm_parts WHERE id=?').get(id);
  });

  app.delete('/api/armory/parts/:id', async (req) => {
    const hh = requireArmory(req, 'member');
    const { id } = parse(idParam, req.params);
    const r = db.prepare('DELETE FROM firearm_parts WHERE id=? AND household_id=?').run(id, hh);
    if (!r.changes) throw new HttpError(404, 'Part not found');
    touchWrite(db);
    return { ok: true };
  });

  // ---------- ammunition ----------
  app.post('/api/armory/ammo', async (req) => {
    const hh = requireArmory(req, 'member');
    const b = parse(ammoInput, req.body);
    const t = Date.now();
    const id = Number(db.prepare(`INSERT INTO ammo (household_id,caliber,brand,line,grain,bullet,purpose,rounds,min_rounds,location,barcode,lot,price_per_round,notes,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(hh, caliberLabel(b.caliber), b.brand, b.line, b.grain ?? null, b.bullet, b.purpose, b.rounds, b.min_rounds ?? null,
      b.location, b.barcode ?? null, b.lot, b.price_per_round ?? null, b.notes, t, t).lastInsertRowid);
    touchWrite(db);
    return decorateAmmo(getAmmo(hh, id));
  });

  app.patch('/api/armory/ammo/:id', async (req) => {
    const hh = requireArmory(req, 'member');
    const { id } = parse(idParam, req.params);
    const n = { ...getAmmo(hh, id), ...parsePatch(ammoInput, req.body) } as z.infer<typeof ammoInput>;
    db.prepare(`UPDATE ammo SET caliber=?,brand=?,line=?,grain=?,bullet=?,purpose=?,rounds=?,min_rounds=?,location=?,barcode=?,lot=?,price_per_round=?,notes=?,updated_at=? WHERE id=? AND household_id=?`)
      .run(caliberLabel(n.caliber), n.brand, n.line, n.grain ?? null, n.bullet, n.purpose, n.rounds, n.min_rounds ?? null, n.location, n.barcode ?? null, n.lot, n.price_per_round ?? null, n.notes, Date.now(), id, hh);
    touchWrite(db);
    return decorateAmmo(getAmmo(hh, id));
  });

  /** Add or remove rounds (a new box, a gifted box, a count correction). */
  app.post('/api/armory/ammo/:id/adjust', async (req) => {
    const hh = requireArmory(req, 'member');
    const { id } = parse(idParam, req.params);
    const { delta } = parse(z.object({ delta: z.number().int().min(-1e6).max(1e6) }), req.body);
    getAmmo(hh, id);
    db.prepare('UPDATE ammo SET rounds=MAX(0, rounds+?), updated_at=? WHERE id=? AND household_id=?').run(delta, Date.now(), id, hh);
    touchWrite(db);
    return decorateAmmo(getAmmo(hh, id));
  });

  app.delete('/api/armory/ammo/:id', async (req) => {
    const hh = requireArmory(req, 'member');
    const { id } = parse(idParam, req.params);
    getAmmo(hh, id);
    db.prepare('DELETE FROM ammo WHERE id=? AND household_id=?').run(id, hh);
    touchWrite(db);
    return { ok: true };
  });

  /** Barcode lookup against this household's own ammo lots (ammo boxes are rarely in public databases). */
  app.get('/api/armory/ammo/barcode/:upc', async (req) => {
    const hh = requireArmory(req);
    const { upc } = parse(z.object({ upc: z.string().regex(/^\d{6,14}$/) }), req.params);
    const a = db.prepare('SELECT * FROM ammo WHERE household_id=? AND barcode=? ORDER BY updated_at DESC LIMIT 1').get(hh, upc) as AmmoRow | undefined;
    return { match: a ? decorateAmmo(a) : null };
  });

  // ---------- range sessions ----------
  app.post('/api/armory/sessions', async (req) => {
    const hh = requireArmory(req, 'member');
    const b = parse(z.object({
      firearm_id: z.number().int(), ammo_id: z.number().int().nullish(), rounds: z.number().int().min(1).max(100000),
      on_date: isoDate.optional(), notes: str(1000).default(''),
    }), req.body);
    const f = getFirearm(hh, b.firearm_id);
    const a = b.ammo_id != null ? getAmmo(hh, b.ammo_id) : null;
    const id = db.transaction(() => {
      db.prepare('UPDATE firearms SET round_count=round_count+?, updated_at=? WHERE id=? AND household_id=?').run(b.rounds, Date.now(), f.id, hh);
      if (a) db.prepare('UPDATE ammo SET rounds=MAX(0, rounds-?), updated_at=? WHERE id=? AND household_id=?').run(b.rounds, Date.now(), a.id, hh);
      return Number(db.prepare(`INSERT INTO range_sessions (household_id,firearm_id,ammo_id,firearm_label,ammo_label,rounds,on_date,notes,user_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(hh, f.id, a?.id ?? null, firearmLabel(f), a ? ammoLabel(a) : '', b.rounds, b.on_date ?? todayIn(getSettings(db, hh).timezone), b.notes, req.ctx!.user.id, Date.now()).lastInsertRowid);
    })();
    touchWrite(db);
    const warn = a && a.rounds < b.rounds ? `Only ${a.rounds} rounds were recorded in that lot; it is now 0.` : null;
    return { id, warning: warn };
  });

  /** Undo a session: gives the rounds back to the lot and takes them off the firearm. */
  app.delete('/api/armory/sessions/:id', async (req) => {
    const hh = requireArmory(req, 'member');
    const { id } = parse(idParam, req.params);
    const s = db.prepare('SELECT * FROM range_sessions WHERE id=? AND household_id=?').get(id, hh) as { firearm_id: number | null; ammo_id: number | null; rounds: number } | undefined;
    if (!s) throw new HttpError(404, 'Session not found');
    db.transaction(() => {
      if (s.firearm_id) db.prepare('UPDATE firearms SET round_count=MAX(0, round_count-?), rounds_at_clean=MIN(rounds_at_clean, MAX(0, round_count-?)) WHERE id=? AND household_id=?').run(s.rounds, s.rounds, s.firearm_id, hh);
      if (s.ammo_id) db.prepare('UPDATE ammo SET rounds=rounds+? WHERE id=? AND household_id=?').run(s.rounds, s.ammo_id, hh);
      db.prepare('DELETE FROM range_sessions WHERE id=? AND household_id=?').run(id, hh);
    })();
    touchWrite(db);
    return { ok: true };
  });

  // ---------- insurance / records export ----------
  app.get('/api/armory/export.csv', async (req, reply) => {
    const hh = requireArmory(req, 'member');
    const cell = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const rows: unknown[][] = [['record', 'make', 'model', 'variant/category', 'caliber', 'serial', 'acquired', 'price', 'status/qty', 'location', 'attached to', 'notes']];
    const firearms = db.prepare('SELECT * FROM firearms WHERE household_id=? ORDER BY make, model').all(hh) as (FirearmRow & { acquired_on: string; location: string; notes: string })[];
    for (const f of firearms) rows.push(['firearm', f.make, f.model, f.variant, caliberLabel(f.caliber), f.serial, f.acquired_on, f.price, f.status, f.location, '', f.notes]);
    const parts = db.prepare(`SELECT p.*, f.make || ' ' || f.model AS fl FROM firearm_parts p LEFT JOIN firearms f ON f.id=p.firearm_id WHERE p.household_id=? ORDER BY fl, p.category`).all(hh) as Record<string, unknown>[];
    for (const p of parts) rows.push(['part', p.make, p.model, p.category, '', p.serial, p.installed_on, p.price, p.qty, '', p.fl ?? 'spare', p.notes]);
    const ammo = db.prepare('SELECT * FROM ammo WHERE household_id=? ORDER BY caliber').all(hh) as Record<string, unknown>[];
    for (const a of ammo) rows.push(['ammo', a.brand, a.line, `${a.grain ?? ''}gr ${a.bullet}`.trim(), a.caliber, a.lot, '', a.price_per_round != null ? Number(a.price_per_round) * Number(a.rounds) : '', a.rounds, a.location, '', a.notes]);
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="bunkerr-armory.csv"');
    return rows.map((r) => r.map(cell).join(',')).join('\n');
  });
}
