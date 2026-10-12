import { createOffline, HttpError, OfflineError } from './offline/core';
import { openKV, type KV } from './offline/kv';

export { HttpError as ApiError, OfflineError };

type Listener = () => void;
const unauthorizedListeners = new Set<Listener>();
export const onUnauthorized = (fn: Listener) => { unauthorizedListeners.add(fn); return () => unauthorizedListeners.delete(fn); };

/** The network call itself. GETs give up after 10 s so a dead connection falls back to saved data quickly. */
async function raw(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: { 'x-bunkerr': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(method === 'GET' ? 10000 : 20000),
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith('/api/auth/')) unauthorizedListeners.forEach((f) => f());
    throw new HttpError(res.status, (data && data.error) || `HTTP ${res.status}`);
  }
  return data;
}

// IndexedDB opens asynchronously; calls wait for it.
const kvReady = openKV();
const lazyKV: KV = {
  get: async (s, k) => (await kvReady).get(s, k),
  set: async (s, k, v) => (await kvReady).set(s, k, v),
  del: async (s, k) => (await kvReady).del(s, k),
  entries: async (s) => (await kvReady).entries(s),
  clear: async (s) => (await kvReady).clear(s),
};

export const offline = createOffline(lazyKV, raw);

export const api = {
  get: <T = any>(url: string) => offline.get<T>(url),
  post: <T = any>(url: string, body: unknown = {}) => offline.mutate<T>('POST', url, body),
  patch: <T = any>(url: string, body: unknown) => offline.mutate<T>('PATCH', url, body),
  put: <T = any>(url: string, body: unknown) => offline.mutate<T>('PUT', url, body),
  del: <T = any>(url: string, body?: unknown) => offline.mutate<T>('DELETE', url, body),
};

export const qs = (o: Record<string, string | number | undefined | null>) => {
  const p = new URLSearchParams();
  Object.entries(o).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') p.set(k, String(v)); });
  const s = p.toString();
  return s ? `?${s}` : '';
};
