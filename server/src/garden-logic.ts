import { addDays, daysBetween } from './util.js';

export interface PlantInfo { days_to_germ: number; days_to_maturity: number; water_every_days: number }
export interface PlantingInfo { planted_on: string; last_watered: string | null; harvested_on: string | null }

export type Stage = 'sown' | 'growing' | 'ready' | 'harvested';

export interface PlantingStatus {
  germ_on: string;
  harvest_on: string;
  next_water: string | null;
  water_due: boolean;
  days_to_harvest: number;
  stage: Stage;
  progress: number; // 0..1 toward maturity
}

export function plantingStatus(p: PlantingInfo, plant: PlantInfo, today: string): PlantingStatus {
  const germ_on = addDays(p.planted_on, plant.days_to_germ);
  const harvest_on = addDays(p.planted_on, plant.days_to_maturity);
  const age = daysBetween(p.planted_on, today);
  const progress = Math.max(0, Math.min(1, age / plant.days_to_maturity));
  const days_to_harvest = daysBetween(today, harvest_on);
  let stage: Stage = p.harvested_on ? 'harvested' : age < plant.days_to_germ ? 'sown' : days_to_harvest <= 0 ? 'ready' : 'growing';
  const lastWater = p.last_watered ?? p.planted_on;
  const next_water = stage === 'harvested' ? null : addDays(lastWater, plant.water_every_days);
  return {
    germ_on, harvest_on, next_water, days_to_harvest, stage, progress,
    water_due: next_water != null && daysBetween(today, next_water) <= 0,
  };
}

export interface Rect { row: number; col: number; w: number; h: number }

export const overlaps = (a: Rect, b: Rect) =>
  a.col < b.col + b.w && b.col < a.col + a.w && a.row < b.row + b.h && b.row < a.row + a.h;

export const inBounds = (r: Rect, rows: number, cols: number) =>
  r.row >= 0 && r.col >= 0 && r.row + r.h <= rows && r.col + r.w <= cols;
