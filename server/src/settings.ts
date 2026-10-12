import { z } from 'zod';
import type { DB } from './db.js';

export const settingsSchema = z.object({
  timezone: z.string().default('America/New_York'),
  digestEnabled: z.boolean().default(true),
  digestTime: z.string().regex(/^\d{2}:\d{2}$/).default('08:00'),
  expirySoonDays: z.number().int().min(1).max(365).default(30),
  expiryUpcomingDays: z.number().int().min(1).max(730).default(90),
  meshOfflineMinutes: z.number().int().min(5).max(10080).default(120),
  meshLowBattery: z.number().min(0).max(100).default(20),
  people: z.number().int().min(1).max(50).default(2),
  kcalPerPersonDay: z.number().int().min(500).max(6000).default(2000),
  /** Armory tab on/off for the household (off for households without firearms). Data is kept either way. */
  armoryEnabled: z.boolean().default(true),
  /** Armory privacy: hidden from viewer accounts and kept out of chat digests unless opted in. */
  armoryViewers: z.boolean().default(false),
  armoryDigest: z.boolean().default(false),
  notify: z.object({
    /** Route through the instance's webhook router (instance admins only; needs WEBHOOK_ROUTER_URL). */
    router: z.boolean().default(false),
    routerSource: z.string().regex(/^[a-z0-9-]{1,40}$/).default('bunkerr'),
    discord: z.boolean().default(true),
    discordWebhook: z.string().default(''),
    ntfy: z.boolean().default(false),
    ntfyServer: z.string().default('https://ntfy.sh'),
    ntfyTopic: z.string().default(''),
    ntfyToken: z.string().default(''),
  }).prefault({}),
});

export type Settings = z.infer<typeof settingsSchema>;

export function getSettings(db: DB, householdId: number): Settings {
  const row = db.prepare('SELECT json FROM settings WHERE household_id=?').get(householdId) as { json: string } | undefined;
  const parsed = settingsSchema.safeParse(row ? JSON.parse(row.json) : {});
  return parsed.success ? parsed.data : settingsSchema.parse({});
}

export function saveSettings(db: DB, householdId: number, s: Settings) {
  db.prepare(`INSERT INTO settings (household_id,json) VALUES (?,?) ON CONFLICT(household_id) DO UPDATE SET json=excluded.json`)
    .run(householdId, JSON.stringify(s));
}

const mask = (v: string) => (v ? `${v.slice(0, 12)}…${v.slice(-4)}` : '');

/** Non-owners see secrets masked. */
export function publicSettings(s: Settings, isOwner: boolean): Settings {
  if (isOwner) return s;
  return { ...s, notify: { ...s.notify, discordWebhook: mask(s.notify.discordWebhook), ntfyToken: s.notify.ntfyToken ? '••••' : '' } };
}
