import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';
import { requireHousehold } from '../auth.js';
import { config } from '../config.js';
import { gtinCandidates, kcalPerPackage, offCategory, packageGrams } from '../barcodes/parse.js';
import { parse } from '../util.js';

const CACHE_MS = 30 * 24 * 3600 * 1000;
const MISS_CACHE_MS = 24 * 3600 * 1000;
const ONLINE_TIMEOUT = 4000;
const UA = 'Bunkerr/0.1 (self-hosted household inventory)';

export interface Product {
  upc: string; found: boolean; name: string | null; brand: string | null; quantity: string | null;
  category: string | null; image: string | null;
  /** Calories in the whole package. */
  kcal: number | null;
  /** usda | off | usda+off (offline mirror), off-online | opf | obf | opff | upcitemdb */
  source: string | null;
}

type Outcome = { kind: 'hit'; p: Product } | { kind: 'miss' } | { kind: 'error' };

const notFound = (upc: string): Product => ({ upc, found: false, name: null, brand: null, quantity: null, category: null, image: null, kcal: null, source: null });

/** Open Food Facts and its sister databases share one API. Order is priority when several answer. */
const OFF_FAMILY = [
  { source: 'off-online', host: 'world.openfoodfacts.org', category: (t: string) => offCategory(t) },
  { source: 'opf', host: 'world.openproductsfacts.org', category: (t: string) => nonFoodCategory(t) },
  { source: 'obf', host: 'world.openbeautyfacts.org', category: () => 'hygiene' },
  { source: 'opff', host: 'world.openpetfoodfacts.org', category: () => 'other' },
];

function nonFoodCategory(t: string): string {
  if (/batter|flashlight|charger|power-bank|solar/i.test(t)) return 'power';
  if (/first-aid|medic|bandage|pharma|vitamin/i.test(t)) return 'medical';
  if (/soap|toilet|tooth|hygiene|shampoo|deodorant|cleaning|diaper|tissue/i.test(t)) return 'hygiene';
  if (/tool|hardware|tape|knife|rope/i.test(t)) return 'tools';
  if (/radio|antenna/i.test(t)) return 'comms';
  if (/seed|garden|fertili/i.test(t)) return 'garden';
  if (/water/i.test(t)) return 'water';
  if (/food|beverage|snack|grocer/i.test(t)) return 'food';
  return 'other';
}

async function offFamily(upc: string, site: (typeof OFF_FAMILY)[number], fetcher: typeof fetch): Promise<Outcome> {
  try {
    const res = await fetcher(`https://${site.host}/api/v2/product/${encodeURIComponent(upc)}.json?fields=product_name,brands,quantity,product_quantity,categories_tags,image_small_url,nutriments`, {
      headers: { 'user-agent': UA }, signal: AbortSignal.timeout(ONLINE_TIMEOUT),
    });
    if (res.status === 404) return { kind: 'miss' };
    if (!res.ok) return { kind: 'error' };
    const j = await res.json() as { status: number; product?: { product_name?: string; brands?: string; quantity?: string; product_quantity?: number | string; categories_tags?: string[]; image_small_url?: string; nutriments?: Record<string, number> } };
    const pr = j.product;
    if (j.status !== 1 || !pr?.product_name?.trim()) return { kind: 'miss' };
    const per100 = pr.nutriments?.['energy-kcal_100g'] ?? (pr.nutriments?.['energy-kj_100g'] != null ? pr.nutriments['energy-kj_100g'] / 4.184 : null);
    const grams = Number(pr.product_quantity) || packageGrams(pr.quantity);
    return {
      kind: 'hit',
      p: {
        upc, found: true, name: pr.product_name.trim(), brand: pr.brands?.split(',')[0]?.trim() || null, quantity: pr.quantity || null,
        category: site.category((pr.categories_tags ?? []).join(' ')), image: pr.image_small_url || null,
        kcal: site.source === 'off-online' ? kcalPerPackage(per100, grams) : null, source: site.source,
      },
    };
  } catch {
    return { kind: 'error' };
  }
}

/** UPCitemdb's free tier (about 100 lookups/day per IP): general merchandise the open databases lack. */
async function upcItemDb(upc: string, fetcher: typeof fetch): Promise<Outcome> {
  try {
    const res = await fetcher(`https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(upc)}`, {
      headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(ONLINE_TIMEOUT),
    });
    if (res.status === 404 || res.status === 400) return { kind: 'miss' };
    if (!res.ok) return { kind: 'error' }; // 429 when the daily quota is used up: try again tomorrow, don't cache
    const j = await res.json() as { code?: string; items?: { title?: string; brand?: string; category?: string; size?: string; images?: string[] }[] };
    const it = j.items?.[0];
    if (!it?.title?.trim()) return { kind: 'miss' };
    const brand = it.brand?.trim() || null;
    let name = it.title.trim();
    if (brand && name.toLowerCase().startsWith(brand.toLowerCase() + ' ')) name = name.slice(brand.length + 1);
    return {
      kind: 'hit',
      p: {
        upc, found: true, name: name.slice(0, 160), brand, quantity: it.size?.trim() || null, category: nonFoodCategory(it.category ?? ''),
        image: it.images?.find((u) => u.startsWith('https://')) ?? null, kcal: null, source: 'upcitemdb',
      },
    };
  } catch {
    return { kind: 'error' };
  }
}

/**
 * Offline mirror first (instant, works with the internet down), then the online cache, then the
 * Open Food Facts family in parallel, then UPCitemdb only if every open database said "unknown".
 * If any online source failed (offline, timeout) the miss isn't cached and UPCitemdb isn't asked.
 */
export async function lookupUpc(deps: AppDeps, upc: string, fetcher: typeof fetch = fetch): Promise<Product> {
  const { db } = deps;
  const hit = deps.barcodes?.lookup(upc);
  if (hit) return { upc, found: true, ...hit };

  const cached = db.prepare('SELECT * FROM barcode_cache WHERE upc=?').get(upc) as (Omit<Product, 'found'> & { found: number; fetched_at: number }) | undefined;
  if (cached && Date.now() - cached.fetched_at < (cached.found ? CACHE_MS : MISS_CACHE_MS)) {
    const { fetched_at: _f, ...rest } = cached;
    return { ...rest, found: !!cached.found };
  }
  if (!config.barcodeOnline) return notFound(upc);

  // UPC-E codes are stored online under their UPC-A form; ask for that when it applies.
  const query = upc.length === 8 ? (gtinCandidates(upc)[1] ?? upc) : upc;
  const outcomes = await Promise.all(OFF_FAMILY.map((s) => offFamily(query, s, fetcher)));
  let found = outcomes.find((o): o is Extract<Outcome, { kind: 'hit' }> => o.kind === 'hit')?.p ?? null;
  const definitive = outcomes.every((o) => o.kind !== 'error');
  if (!found && definitive && config.upcitemdb) {
    const u = await upcItemDb(query, fetcher);
    if (u.kind === 'error') return notFound(upc);
    if (u.kind === 'hit') found = u.p;
  }
  if (!found && !definitive) return notFound(upc);
  const p = found ? { ...found, upc } : notFound(upc);
  db.prepare(`INSERT INTO barcode_cache (upc,name,brand,quantity,category,image,kcal,source,found,fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(upc) DO UPDATE SET name=excluded.name,brand=excluded.brand,quantity=excluded.quantity,category=excluded.category,image=excluded.image,
      kcal=excluded.kcal,source=excluded.source,found=excluded.found,fetched_at=excluded.fetched_at`)
    .run(upc, p.name, p.brand, p.quantity, p.category, p.image, p.kcal, p.source, p.found ? 1 : 0, Date.now());
  return p;
}

export default async function barcodeRoutes(app: FastifyInstance, deps: AppDeps) {
  app.get('/api/barcode/:upc', async (req) => {
    const hh = requireHousehold(req);
    const { upc } = parse(z.object({ upc: z.string().regex(/^\d{6,14}$/, 'barcode must be 6-14 digits') }), req.params);
    // The household's own past entry for this barcode beats the public database.
    const own = deps.db.prepare(`SELECT name, category, unit, location, kcal_per_unit, min_qty FROM items WHERE household_id=? AND barcode=? ORDER BY updated_at DESC LIMIT 1`).get(hh, upc);
    const product = await lookupUpc(deps, upc);
    return { product, own: own ?? null };
  });
}
