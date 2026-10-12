import type { DB } from './db.js';
import { lowStock } from './routes/inventory.js';
import { gardenTasks } from './routes/garden.js';
import { armorySummary } from './routes/armory.js';
import { powerSummary } from './routes/power.js';
import { getSettings } from './settings.js';
import { addDays, daysBetween, todayIn } from './util.js';

const GALLON_UNITS: Record<string, number> = { gal: 1, gallon: 1, gallons: 1, l: 1 / 3.785, liter: 1 / 3.785, liters: 1 / 3.785, litre: 1 / 3.785 };

export function householdSummary(db: DB, hh: number) {
  const s = getSettings(db, hh);
  const today = todayIn(s.timezone);
  const soonCutoff = addDays(today, s.expirySoonDays);
  const expiring = db.prepare(`SELECT id,name,qty,unit,location,expires_on FROM items WHERE household_id=? AND expires_on IS NOT NULL AND expires_on<=?
    ORDER BY expires_on, name`).all(hh, soonCutoff) as { id: number; name: string; qty: number; unit: string; location: string; expires_on: string }[];
  const expired = expiring.filter((i) => i.expires_on < today);
  const soon = expiring.filter((i) => i.expires_on >= today);

  const counts = db.prepare(`SELECT category, COUNT(*) AS batches, SUM(qty) AS qty FROM items WHERE household_id=? GROUP BY category`).all(hh) as { category: string; batches: number; qty: number }[];

  const kcal = (db.prepare(`SELECT SUM(qty*kcal_per_unit) AS k, COUNT(*) AS n FROM items WHERE household_id=? AND category='food' AND kcal_per_unit IS NOT NULL`).get(hh) as { k: number | null; n: number });
  const foodDays = kcal.k ? kcal.k / (s.people * s.kcalPerPersonDay) : null;
  const waterRows = db.prepare(`SELECT qty, lower(unit) AS unit FROM items WHERE household_id=? AND category='water'`).all(hh) as { qty: number; unit: string }[];
  const gallons = waterRows.reduce((sum, r) => sum + r.qty * (GALLON_UNITS[r.unit] ?? 0), 0);
  const waterDays = gallons ? gallons / s.people : null; // FEMA: 1 gal/person/day

  const tasks = gardenTasks(db, hh, today, 7);
  const waterDue = tasks.filter((t) => t.kind === 'water' && t.date <= today);
  const harvestReady = tasks.filter((t) => t.kind === 'harvest' && t.date <= today);

  const offlineMs = s.meshOfflineMinutes * 60000;
  const nodes = db.prepare('SELECT id,node_id,label,long_name,short_name,site,last_heard,battery FROM mesh_nodes WHERE household_id=?').all(hh) as
    { id: number; node_id: string; label: string; long_name: string | null; short_name: string | null; site: string; last_heard: number | null; battery: number | null }[];
  const nodeName = (n: (typeof nodes)[number]) => n.label || n.long_name || n.node_id;
  // Never-heard nodes are "pending", not offline: they were just claimed or their gateway isn't set up yet.
  const meshOffline = nodes.filter((n) => n.last_heard != null && Date.now() - n.last_heard >= offlineMs).map((n) => ({ ...n, name: nodeName(n) }));
  const meshPending = nodes.filter((n) => n.last_heard == null).length;
  const meshLowBattery = nodes.filter((n) => n.battery != null && n.battery <= s.meshLowBattery && n.battery <= 100).map((n) => ({ ...n, name: nodeName(n) }));

  return {
    today, settings: s, expired, soon, lowStock: lowStock(db, hh), counts,
    foodDays, foodKcalItems: kcal.n, waterGallons: gallons, waterDays,
    tasks, waterDue, harvestReady,
    mesh: { total: nodes.length, pending: meshPending, offline: meshOffline, lowBattery: meshLowBattery },
    armory: armorySummary(db, hh),
    power: powerSummary(db, hh, today),
  };
}

export type Summary = ReturnType<typeof householdSummary>;

const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n - 1) + '…' : s.padEnd(n));

/** Plain monospace digest lines (rendered inside a code block in Discord). Empty when there's nothing to report. */
export function digestLines(sum: Summary): string[] {
  const out: string[] = [];
  const rel = (d: string) => { const n = daysBetween(sum.today, d); return n < 0 ? `${-n}d ago` : n === 0 ? 'today' : `in ${n}d`; };
  if (sum.expired.length) {
    out.push(`EXPIRED (${sum.expired.length})`);
    sum.expired.slice(0, 10).forEach((i) => out.push(`  ✗ ${pad(i.name, 28)} ${String(i.qty).padStart(4)} ${pad(i.unit, 5)} ${rel(i.expires_on)}`));
    if (sum.expired.length > 10) out.push(`  … +${sum.expired.length - 10} more`);
  }
  if (sum.soon.length) {
    out.push(`USE SOON (${sum.soon.length}, next ${sum.settings.expirySoonDays}d)`);
    sum.soon.slice(0, 12).forEach((i) => out.push(`  ! ${pad(i.name, 28)} ${String(i.qty).padStart(4)} ${pad(i.unit, 5)} ${rel(i.expires_on)}`));
    if (sum.soon.length > 12) out.push(`  … +${sum.soon.length - 12} more`);
  }
  if (sum.lowStock.length) {
    out.push(`LOW STOCK (${sum.lowStock.length})`);
    sum.lowStock.slice(0, 10).forEach((i) => out.push(`  ↓ ${pad(i.name, 28)} ${i.total}/${i.min_qty} ${i.unit}`));
  }
  if (sum.waterDue.length) {
    out.push(`WATER TODAY (${sum.waterDue.length})`);
    const byGarden = new Map<string, string[]>();
    sum.waterDue.forEach((t) => byGarden.set(t.garden, [...(byGarden.get(t.garden) ?? []), t.plant]));
    byGarden.forEach((plants, g) => out.push(`  ~ ${g}: ${[...new Set(plants)].join(', ')}`));
  }
  if (sum.harvestReady.length) {
    out.push(`READY TO HARVEST (${sum.harvestReady.length})`);
    sum.harvestReady.slice(0, 10).forEach((t) => out.push(`  * ${t.plant} — ${t.garden}`));
  }
  if (sum.power.due.length) {
    out.push(`POWER UPKEEP DUE (${sum.power.due.length})`);
    sum.power.due.slice(0, 10).forEach((t) => out.push(`  ⚡ ${pad(t.equipment_name, 20)} ${pad(t.label, 26)} ${rel(t.next_due_on)}`));
    if (sum.power.due.length > 10) out.push(`  … +${sum.power.due.length - 10} more`);
  }
  // Armory lines only when the household opted in (Settings → armory in digest). Never serials.
  const armoryLines = sum.settings.armoryEnabled && sum.settings.armoryDigest;
  if (armoryLines && sum.armory.lowAmmo.length) {
    out.push(`LOW AMMO (${sum.armory.lowAmmo.length})`);
    sum.armory.lowAmmo.forEach((c) => out.push(`  ↓ ${pad(c.label, 28)} ${c.rounds}/${c.min} rds`));
  }
  if (armoryLines && sum.armory.cleaningDue.length) {
    out.push(`CLEANING DUE (${sum.armory.cleaningDue.length})`);
    sum.armory.cleaningDue.forEach((f) => out.push(`  # ${pad(f.label, 28)} ${f.since} rds since last clean`));
  }
  if (sum.mesh.offline.length) {
    out.push(`MESH NODES OFFLINE (${sum.mesh.offline.length}/${sum.mesh.total})`);
    sum.mesh.offline.forEach((n) => out.push(`  ⚠ ${n.name}${n.site ? ` @ ${n.site}` : ''}`));
  }
  return out;
}
