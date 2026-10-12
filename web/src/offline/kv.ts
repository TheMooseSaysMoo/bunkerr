/**
 * Tiny key-value store over IndexedDB, with an in-memory fallback where IndexedDB isn't
 * available (some private-browsing modes, tests). Three stores: cached GET responses, the
 * outbox of changes made offline, and small bits of state.
 */
export type StoreName = 'cache' | 'outbox' | 'meta';
const STORES: StoreName[] = ['cache', 'outbox', 'meta'];

export interface KV {
  get<T>(store: StoreName, key: string): Promise<T | undefined>;
  set(store: StoreName, key: string, value: unknown): Promise<void>;
  del(store: StoreName, key: string): Promise<void>;
  entries<T>(store: StoreName): Promise<[string, T][]>;
  clear(store: StoreName): Promise<void>;
}

export function memoryKV(): KV {
  const m = new Map<StoreName, Map<string, unknown>>(STORES.map((s) => [s, new Map()]));
  const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  return {
    async get(s, k) { return clone(m.get(s)!.get(k)) as never; },
    async set(s, k, v) { m.get(s)!.set(k, clone(v)); },
    async del(s, k) { m.get(s)!.delete(k); },
    async entries(s) { return [...m.get(s)!.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, clone(v)] as [string, never]); },
    async clear(s) { m.get(s)!.clear(); },
  };
}

function idbKV(db: IDBDatabase): KV {
  const run = <T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) =>
    new Promise<T>((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  return {
    get: (s, k) => run(s, 'readonly', (o) => o.get(k)),
    set: async (s, k, v) => { await run(s, 'readwrite', (o) => o.put(v, k)); },
    del: async (s, k) => { await run(s, 'readwrite', (o) => o.delete(k)); },
    entries: (s) => new Promise((resolve, reject) => {
      const out: [string, any][] = [];
      const tx = db.transaction(s, 'readonly');
      const req = tx.objectStore(s).openCursor();
      req.onsuccess = () => { const c = req.result; if (c) { out.push([String(c.key), c.value]); c.continue(); } };
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => reject(tx.error);
    }),
    clear: async (s) => { await run(s, 'readwrite', (o) => o.clear()); },
  };
}

export async function openKV(): Promise<KV> {
  try {
    if (typeof indexedDB === 'undefined') return memoryKV();
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('bunkerr-offline', 1);
      req.onupgradeneeded = () => { for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('blocked'));
    });
    return idbKV(db);
  } catch {
    return memoryKV();
  }
}
