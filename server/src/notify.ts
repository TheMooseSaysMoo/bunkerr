import type { DB } from './db.js';
import { getSettings, type Settings } from './settings.js';
import { emailHousehold, type EmailKind, type Mailer } from './mailer.js';

export interface Message {
  title: string;
  lines: string[];
  priority?: 'low' | 'default' | 'high';
  url?: string;
  /** ntfy-style actions ("http, Approve, <url>, method=POST; ..."). A router that supports them can turn them into buttons or reactions. */
  actions?: string;
  /** Also email household members subscribed to this kind (digest / urgent alerts). */
  email?: EmailKind;
  /** Body for viewer accounts when it differs (the digest without armory lines). */
  viewerLines?: string[];
}

export interface Provider {
  name: string;
  enabled(s: Settings): boolean;
  send(s: Settings, m: Message): Promise<void>;
}

const DISCORD_COLOR = { low: 0x6b7280, default: 0x3fb950, high: 0xf85149 } as const;

export const discord: Provider = {
  name: 'discord',
  enabled: (s) => s.notify.discord && /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//.test(s.notify.discordWebhook),
  async send(s, m) {
    const description = m.lines.join('\n').slice(0, 4000);
    const res = await fetch(s.notify.discordWebhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'Bunkerr',
        embeds: [{ title: m.title.slice(0, 250), description: '```\n' + description + '\n```', url: m.url, color: DISCORD_COLOR[m.priority ?? 'default'] }],
      }),
    });
    if (!res.ok) throw new Error(`Discord ${res.status}: ${(await res.text()).slice(0, 200)}`);
  },
};

export const ntfy: Provider = {
  name: 'ntfy',
  enabled: (s) => s.notify.ntfy && !!s.notify.ntfyTopic,
  async send(s, m) {
    const headers: Record<string, string> = {
      Title: m.title,
      Priority: m.priority === 'high' ? '4' : m.priority === 'low' ? '2' : '3',
      Tags: 'package',
    };
    if (m.url) headers.Click = m.url;
    if (s.notify.ntfyToken) headers.Authorization = `Bearer ${s.notify.ntfyToken}`;
    const base = s.notify.ntfyServer.replace(/\/$/, '');
    const res = await fetch(`${base}/${encodeURIComponent(s.notify.ntfyTopic)}`, { method: 'POST', headers, body: m.lines.join('\n') });
    if (!res.ok) throw new Error(`ntfy ${res.status}: ${(await res.text()).slice(0, 200)}`);
  },
};

/**
 * Optional webhook router: anything that accepts Home Assistant-style webhooks
 * ({source, title, body, priority[, actions]}). When a household routes through it, the router
 * decides where messages go, and Bunkerr sends only to it (direct Discord/ntfy are the fallback).
 */
export function webhookRouterProvider(baseUrl: string): Provider {
  const PRIORITY = { low: 'low', default: 'default', high: 'high' } as const;
  return {
    name: 'router',
    enabled: (s) => !!baseUrl && s.notify.router,
    async send(s, m) {
      const body = '```\n' + m.lines.join('\n').slice(0, 3800) + '\n```' + (m.url ? `\n${m.url}` : '');
      // A base URL gets the Home Assistant-style webhook path; a full URL is used as given.
      const url = /\/api\/webhook\//.test(baseUrl) ? baseUrl : `${baseUrl.replace(/\/$/, '')}/api/webhook/homelab_alert`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: s.notify.routerSource || 'bunkerr', title: m.title, body, priority: PRIORITY[m.priority ?? 'default'], ...(m.actions ? { actions: m.actions } : {}) }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`webhook router ${res.status}`);
    },
  };
}

export const PROVIDERS: Provider[] = [discord, ntfy];

export interface Notifier {
  send(householdId: number, m: Message): Promise<{ sent: string[]; errors: string[] }>;
}

/**
 * `primary` (the webhook router) is tried first when enabled; the direct providers run only if it is
 * disabled or fails — e.g. on the off-site standby during a whole-home outage.
 */
export function createNotifier(db: DB, providers = PROVIDERS, primary: Provider | null = null, mailer: Mailer | null = null): Notifier {
  const channels = async (s: Settings, m: Message, sent: string[], errors: string[]) => {
    if (primary?.enabled(s)) {
      try { await primary.send(s, m); sent.push(primary.name); return; }
      catch (e) { errors.push(`${primary.name}: ${(e as Error).message} (falling back)`); }
    }
    for (const p of providers.filter((p) => p.enabled(s))) {
      try { await p.send(s, m); sent.push(p.name); }
      catch (e) { errors.push(`${p.name}: ${(e as Error).message}`); }
    }
  };
  return {
    async send(householdId, m) {
      const s = getSettings(db, householdId);
      const sent: string[] = [];
      const errors: string[] = [];
      await channels(s, m, sent, errors);
      // Email goes to the people who asked for it, in addition to the household's channel.
      if (m.email && mailer) {
        const r = await emailHousehold(db, mailer, householdId, m.email, m);
        if (r.sent) sent.push(`email×${r.sent}`);
        errors.push(...r.errors);
      }
      return { sent, errors };
    },
  };
}

/** Records a notification key; returns false if it was already sent (dedupe). */
export function claimNotification(db: DB, householdId: number, kind: string, ref: string): boolean {
  const r = db.prepare('INSERT OR IGNORE INTO notifications (household_id,kind,ref,sent_at) VALUES (?,?,?,?)').run(householdId, kind, ref, Date.now());
  return r.changes === 1;
}

export function releaseNotification(db: DB, householdId: number, kind: string, ref: string) {
  db.prepare('DELETE FROM notifications WHERE household_id=? AND kind=? AND ref=?').run(householdId, kind, ref);
}
