import type { KV } from './kv';

/**
 * Offline support.
 *
 * Reads: every successful GET of household data is saved, filed under user and household.
 * When the server can't be reached, the saved copy is served instead. Inventory queries are
 * answered from the saved full list, so search, section tabs and expiry filters work offline.
 *
 * Writes: a small set of everyday changes (add item, use/discard, edit, delete, power upkeep
 * done) are queued when offline, applied to the saved data right away, and replayed in order
 * once the server is back. Each carries an Idempotency-Key, so a change whose response was lost
 * is never applied twice. Items added offline get a temporary negative id, swapped for the real
 * one when they sync. Queued changes only ever replay into the household they were made in.
 */

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
/** The thing asked for needs the server and there's no saved copy. */
export class OfflineError extends Error {
  readonly offline = true;
}

/** Status codes that mean "couldn't reach Bunkerr" (Cloudflare/NPM in front of a down origin), not "Bunkerr said no". */
const UNREACHABLE = new Set([502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 530]);
export const isUnreachable = (e: unknown) =>
  e instanceof TypeError || (e as Error)?.name === 'AbortError' || (e as Error)?.name === 'TimeoutError' || (e instanceof HttpError && UNREACHABLE.has(e.status));

export type RawRequest = (method: string, url: string, body?: unknown, headers?: Record<string, string>) => Promise<unknown>;

export interface Op { key: string; method: string; url: string; body?: unknown; at: number; label: string; tempId?: number }
export interface OfflineState { online: boolean; syncing: boolean; pending: number; syncedAt: number | null; problems: string[] }

interface Cached { data: unknown; at: number }
interface ItemLike { id: number; name: string; category: string; qty: number; unit: string; location: string; barcode: string | null; expires_on: string | null; updated_at: number; tier?: string; [k: string]: unknown }

/** GETs worth keeping offline. Admin pages, exports and one-off lookups are not. */
const CACHEABLE = /^\/api\/(me|dashboard|items(\?.*)?|items\/meta|power(\/\d+\/log)?|settings|household|gardens(\/\d+)?|garden\/tasks(\?.*)?|plants|mesh|docs(\/[\w-]+)?|armory|armory\/firearms\/\d+|receipt\/quota|me\/email)$/;

/** Changes that can be made offline. Anything else says "needs a connection". */
const QUEUEABLE: { method: string; re: RegExp; label: (body: any) => string }[] = [
  { method: 'POST', re: /^\/api\/items$/, label: (b) => `add ${b?.name ?? 'item'}` },
  { method: 'POST', re: /^\/api\/items\/-?\d+\/consume$/, label: (b) => `${b?.kind === 'discard' ? 'discard' : 'use'} ${b?.qty ?? 1}` },
  { method: 'PATCH', re: /^\/api\/items\/-?\d+$/, label: (b) => `edit ${b?.name ?? 'item'}` },
  { method: 'DELETE', re: /^\/api\/items\/-?\d+$/, label: () => 'delete item' },
  { method: 'POST', re: /^\/api\/power\/tasks\/\d+\/done$/, label: () => 'power upkeep done' },
];

const newKey = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, '');
const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const addDays = (iso: string, n: number) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

export function tierOf(expires: string | null | undefined, today: string, soon = 30, upcoming = 90) {
  if (!expires) return 'none';
  const d = daysBetween(today, expires);
  return d < 0 ? 'expired' : d <= soon ? 'soon' : d <= upcoming ? 'upcoming' : 'ok';
}

/** Firearm detail is cached with serials masked: no full serial is ever stored on a device. */
function sanitize(url: string, data: any): unknown {
  if (/^\/api\/armory\/firearms\/\d+$/.test(url) && data?.firearm) {
    return { ...data, firearm: { ...data.firearm, serial: data.firearm.serial_masked ?? '' }, parts: (data.parts ?? []).map((p: any) => ({ ...p, serial: p.serial ? `••••${String(p.serial).slice(-4)}` : '' })) };
  }
  return data;
}

export function createOffline(kv: KV, raw: RawRequest, opts: { today?: () => string } = {}) {
  const today = opts.today ?? localToday;
  let scope: string | null = null;
  const st: OfflineState = { online: true, syncing: false, pending: 0, syncedAt: null, problems: [] };
  const listeners = new Set<(s: OfflineState) => void>();
  const dataListeners = new Set<() => void>();
  const emit = () => { const s = { ...st, problems: [...st.problems] }; listeners.forEach((f) => f(s)); };
  const dataChanged = () => dataListeners.forEach((f) => f());
  const k = (url: string) => `${scope}|${url}`;

  const setOnline = (on: boolean) => { if (st.online !== on) { st.online = on; emit(); } };

  async function ops(): Promise<[string, Op][]> {
    if (!scope) return [];
    return (await kv.entries<Op>('outbox')).filter(([key]) => key.startsWith(`${scope}|`));
  }
  async function refreshPending() { st.pending = (await ops()).length; emit(); }

  async function readCache<T>(url: string) { return scope ? (await kv.get<Cached>('cache', k(url)))?.data as T | undefined : undefined; }
  async function writeCache(url: string, data: unknown, sc = scope) { if (sc) await kv.set('cache', `${sc}|${url}`, { data, at: Date.now() } satisfies Cached); }

  // ---------------- offline answers ----------------
  async function settingsWindows() {
    const s = await readCache<{ expirySoonDays?: number; expiryUpcomingDays?: number }>('/api/settings');
    return { soon: s?.expirySoonDays ?? 30, upcoming: s?.expiryUpcomingDays ?? 90 };
  }

  /** Answers /api/items?q=&category=&tier=&sort= from the saved full list. */
  async function itemsQuery(url: string) {
    const full = await readCache<{ items: ItemLike[]; counts?: Record<string, number>; devices?: number }>('/api/items');
    if (!full) return undefined;
    const p = new URL(url, 'http://x').searchParams;
    const { soon, upcoming } = await settingsWindows();
    const td = today();
    let items: ItemLike[] = full.items.map((i) => ({ ...i, tier: tierOf(i.expires_on, td, soon, upcoming) }));
    const counts: Record<string, number> = {};
    items.forEach((i) => { counts[i.category] = (counts[i.category] ?? 0) + 1; });
    const q = (p.get('q') ?? '').toLowerCase();
    if (q) items = items.filter((i) => i.name.toLowerCase().includes(q) || String(i.notes ?? '').toLowerCase().includes(q) || i.barcode === q);
    if (p.get('category')) items = items.filter((i) => i.category === p.get('category'));
    if (p.get('location')) items = items.filter((i) => i.location === p.get('location'));
    if (p.get('tier')) items = items.filter((i) => i.tier === p.get('tier'));
    const by = p.get('sort') ?? 'expiry';
    const name = (a: ItemLike, b: ItemLike) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    items.sort(by === 'name' ? name : by === 'updated' ? (a, b) => b.updated_at - a.updated_at : by === 'category' ? (a, b) => a.category.localeCompare(b.category) || name(a, b)
      : (a, b) => (a.expires_on == null ? 1 : 0) - (b.expires_on == null ? 1 : 0) || String(a.expires_on).localeCompare(String(b.expires_on)) || name(a, b));
    const power = await readCache<{ equipment: unknown[] }>('/api/power');
    return { today: td, items, counts, devices: power?.equipment.length ?? full.devices ?? 0, offline: true };
  }

  /** Offline barcode lookup: only the household's own items (the product database lives on the server). */
  async function barcodeQuery(url: string) {
    const upc = url.split('/').pop()!;
    const full = await readCache<{ items: ItemLike[] }>('/api/items');
    const own = full?.items.find((i) => i.barcode === upc);
    return {
      product: { upc, found: false, name: null, brand: null, quantity: null, category: null, image: null, kcal: null, source: null },
      own: own ? { name: own.name, category: own.category, unit: own.unit, location: own.location, kcal_per_unit: own.kcal_per_unit ?? null, min_qty: own.min_qty ?? null } : null,
      offline: true,
    };
  }

  async function offlineGet(url: string): Promise<unknown> {
    if (url === '/api/items' || url.startsWith('/api/items?')) { const r = await itemsQuery(url); if (r) return r; }
    if (/^\/api\/barcode\/\d+$/.test(url)) return barcodeQuery(url);
    const hit = await readCache(url);
    if (hit !== undefined) return hit;
    throw new OfflineError('Not available offline yet. Open this page once while online.');
  }

  // ---------------- optimistic changes ----------------
  async function updateItems(fn: (items: ItemLike[]) => ItemLike[]) {
    const full = await readCache<{ items: ItemLike[] }>('/api/items');
    if (full) await writeCache('/api/items', { ...full, items: fn(full.items) });
  }

  async function applyLocally(method: string, url: string, body: any, tempId?: number): Promise<unknown> {
    const id = Number(url.match(/\/items\/(-?\d+)/)?.[1]);
    if (method === 'POST' && url === '/api/items') {
      const { soon, upcoming } = await settingsWindows();
      const item: ItemLike = {
        id: tempId!, name: body.name, category: body.category ?? 'food', qty: body.qty ?? 1, unit: body.unit ?? 'ea', location: body.location ?? '',
        barcode: body.barcode ?? null, expires_on: body.expires_on ?? null, opened_on: body.opened_on ?? null, min_qty: body.min_qty ?? null,
        kcal_per_unit: body.kcal_per_unit ?? null, notes: body.notes ?? '', updated_at: Date.now(), pending: true,
      };
      item.tier = tierOf(item.expires_on, today(), soon, upcoming);
      await updateItems((items) => [...items, item]);
      return item;
    }
    if (url.endsWith('/consume')) {
      let res = { id, qty: 0, removed: true };
      await updateItems((items) => items.flatMap((i) => {
        if (i.id !== id) return [i];
        const left = Math.max(0, +(i.qty - Number(body?.qty ?? 1)).toFixed(4));
        res = { id, qty: left, removed: left <= 0 };
        return left <= 0 ? [] : [{ ...i, qty: left, updated_at: Date.now(), pending: true }];
      }));
      return res;
    }
    if (method === 'PATCH' && /^\/api\/items\/-?\d+$/.test(url)) {
      let out: ItemLike | undefined;
      await updateItems((items) => items.map((i) => (i.id === id ? (out = { ...i, ...body, id, updated_at: Date.now(), pending: true }) : i)));
      return out ?? { id };
    }
    if (method === 'DELETE' && /^\/api\/items\/-?\d+$/.test(url)) {
      await updateItems((items) => items.filter((i) => i.id !== id));
      return { ok: true };
    }
    if (url.startsWith('/api/power/tasks/')) {
      const taskId = Number(url.split('/')[4]);
      const doneOn = body?.done_on ?? today();
      let next = doneOn;
      const power = await readCache<any>('/api/power');
      if (power) {
        for (const e of power.equipment) {
          for (const t of e.tasks) {
            if (t.id !== taskId) continue;
            next = addDays(doneOn, t.every_days);
            t.last_done_on = doneOn; t.next_due_on = next;
            t.days_until = daysBetween(today(), next); t.state = t.days_until <= 0 ? 'due' : t.days_until <= 7 ? 'soon' : 'ok';
            if (body?.charge_pct != null) e.charge_pct = body.charge_pct;
            if (body?.run_hours != null) e.run_hours = body.run_hours;
          }
        }
        const all = power.equipment.flatMap((e: any) => e.tasks.map((t: any) => ({ ...t, equipment_name: e.name })));
        power.summary = { ...power.summary, due: all.filter((t: any) => t.state === 'due'), soon: all.filter((t: any) => t.state === 'soon') };
        await writeCache('/api/power', power);
      }
      return { ok: true, last_done_on: doneOn, next_due_on: next };
    }
    return { ok: true };
  }

  // ---------------- sync ----------------
  let flushing: Promise<void> | null = null;
  /** Strictly increasing outbox order, even for two changes in the same millisecond. */
  let lastSeq = 0;
  const nextSeq = () => (lastSeq = Math.max(Date.now(), lastSeq + 1));
  const idmapKey = () => `${scope}|idmap`;
  /** Temporary ids of items added offline → their real ids once synced. */
  async function remapper() {
    const idmap = (await kv.get<Record<string, number>>('meta', idmapKey())) ?? {};
    return { idmap, remap: (url: string) => url.replace(/\/items\/(-\d+)(?=\/|$)/, (m, t) => (idmap[t] ? `/items/${idmap[t]}` : m)) };
  }
  const problem = (msg: string) => { if (!st.problems.includes(msg)) st.problems.push(msg); };

  async function flushNow() {
    if (!scope) return;
    const { idmap, remap } = await remapper();
    let changed = false;
    for (const [key, op] of await ops()) {
      let res: any;
      try {
        res = await raw(op.method, remap(op.url), op.body, { 'idempotency-key': op.key });
      } catch (e) {
        if (isUnreachable(e)) { setOnline(false); break; }
        if (e instanceof HttpError && e.status === 401) break; // signed out: keep the queue until they log back in
        if (e instanceof HttpError && e.status >= 500) { problem(`${op.label}: server error, will retry`); break; }
        // A definite "no" (item since deleted, invalid): drop it and say so.
        problem(`${op.label}: ${(e as Error).message}`);
        res = null;
      }
      setOnline(true);
      if (op.tempId != null && res?.id) { idmap[String(op.tempId)] = res.id; await kv.set('meta', idmapKey(), idmap); }
      await kv.del('outbox', key);
      changed = true;
    }
    await refreshPending();
    // Nothing waiting: no page can still hold a temporary id worth translating after the next reload.
    if (st.pending === 0 && changed) setTimeout(() => { if (st.pending === 0 && scope) void kv.del('meta', idmapKey()); }, 60000);
    if (changed) dataChanged();
  }

  const api = {
    state: (): OfflineState => ({ ...st, problems: [...st.problems] }),
    subscribe(fn: (s: OfflineState) => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    /** Called when saved data changed (offline edit, sync finished): visible pages reload. */
    onData(fn: () => void) { dataListeners.add(fn); return () => { dataListeners.delete(fn); }; },

    async setScope(s: { userId: number; householdId: number | null } | null) {
      scope = s && s.householdId != null ? `u${s.userId}:h${s.householdId}` : null;
      st.syncedAt = scope ? (await kv.get<number>('meta', `${scope}|syncedAt`)) ?? null : null;
      await refreshPending();
    },

    /** Network first; the saved copy (or an offline answer) when the server can't be reached. */
    async get<T>(url: string): Promise<T> {
      // Saved under the household the request started in, even if the user switches while it's in flight.
      const sc = scope;
      try {
        const data = await raw('GET', url);
        setOnline(true);
        if (sc && sc === scope && CACHEABLE.test(url)) {
          // While changes are waiting, the saved full list keeps them visible; don't overwrite it with the server's older view.
          if (!(url === '/api/items' && st.pending > 0)) await writeCache(url, sanitize(url, data), sc);
        }
        return data as T;
      } catch (e) {
        if (!isUnreachable(e)) throw e;
        setOnline(false);
        return (await offlineGet(url)) as T;
      }
    },

    /** Sends a change; if the server can't be reached and it's an everyday change, queues it. */
    async mutate<T>(method: string, url: string, body?: unknown): Promise<T> {
      const q = QUEUEABLE.find((x) => x.method === method && x.re.test(url));
      // Earlier queued changes go first, so they apply in the order they were made.
      if (q && st.pending > 0 && st.online) await api.flush();
      // Already known to be offline, or changes still waiting: queue without making them wait on a failing request.
      const queueNow = q && (st.pending > 0 || !st.online);
      if (!queueNow) {
        try {
          const { remap } = await remapper();
          const res = await raw(method, remap(url), body, { 'idempotency-key': newKey() });
          setOnline(true);
          return res as T;
        } catch (e) {
          if (!isUnreachable(e)) throw e;
          setOnline(false);
          if (!q) throw new OfflineError('You’re offline. This needs a connection.');
        }
      }
      if (!scope) throw new OfflineError('You’re offline. This needs a connection.');
      const tempId = method === 'POST' && url === '/api/items' ? -(Date.now() * 10 + Math.floor(Math.random() * 10)) : undefined;
      const op: Op = { key: newKey(), method, url, body, at: Date.now(), label: q!.label(body), tempId };
      await kv.set('outbox', `${scope}|${String(nextSeq()).padStart(16, '0')}`, op);
      const res = await applyLocally(method, url, body, tempId);
      await refreshPending();
      dataChanged();
      return { ...(res as object), queued: true } as T;
    },

    flush(): Promise<void> {
      flushing ??= (async () => { st.syncing = true; emit(); try { await flushNow(); } finally { st.syncing = false; flushing = null; emit(); } })();
      return flushing;
    },

    /** Downloads the main pages so they work offline even if never opened on this device. */
    async prefetch(urls: string[]) {
      if (!scope || st.pending > 0) return;
      for (const url of urls) {
        try { await api.get(url); } catch (e) { if (e instanceof OfflineError || isUnreachable(e)) return; }
        if (!st.online) return;
      }
      st.syncedAt = Date.now();
      await kv.set('meta', `${scope}|syncedAt`, st.syncedAt);
      emit();
    },

    /** Online again? Sends queued changes, then refreshes saved data. */
    async probe(healthUrl = '/healthz') {
      try { await raw('GET', healthUrl); } catch { setOnline(false); return false; }
      setOnline(true);
      return true;
    },

    async rememberMe(me: unknown) { await kv.set('meta', 'me', me); },
    async lastMe<T>() { return kv.get<T>('meta', 'me'); },
    dismissProblems() { st.problems = []; emit(); },

    /** Logout: nothing from this account stays on the device. */
    async clearAll() {
      await Promise.all([kv.clear('cache'), kv.clear('outbox'), kv.clear('meta')]);
      scope = null; st.pending = 0; st.syncedAt = null; st.problems = []; emit();
    },
  };
  return api;
}

export type Offline = ReturnType<typeof createOffline>;
