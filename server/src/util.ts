import { z } from 'zod';
import { HttpError } from './auth.js';

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const i = r.error.issues[0];
    throw new HttpError(400, `${i.path.join('.') || 'body'}: ${i.message}`);
  }
  return r.data;
}

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
export const idParam = z.object({ id: z.coerce.number().int().positive() });

/** YYYY-MM-DD for "today" in the given IANA timezone. */
export function todayIn(tz = 'America/New_York', d = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export function hhmmIn(tz = 'America/New_York', d = new Date()): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
}

const DAY = 86400000;
const toUtc = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));

/** Whole days from a to b (b - a). */
export const daysBetween = (a: string, b: string) => Math.round((toUtc(b) - toUtc(a)) / DAY);

export function addDays(iso: string, n: number): string {
  return new Date(toUtc(iso) + n * DAY).toISOString().slice(0, 10);
}

export type ExpiryTier = 'expired' | 'soon' | 'upcoming' | 'ok' | 'none';

/** soon = within 30 days, upcoming = within 90 days. */
export function expiryTier(expiresOn: string | null | undefined, today: string, soonDays = 30, upcomingDays = 90): ExpiryTier {
  if (!expiresOn) return 'none';
  const d = daysBetween(today, expiresOn);
  if (d < 0) return 'expired';
  if (d <= soonDays) return 'soon';
  if (d <= upcomingDays) return 'upcoming';
  return 'ok';
}
