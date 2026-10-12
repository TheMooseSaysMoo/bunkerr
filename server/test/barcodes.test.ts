import { Readable } from 'node:stream';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  expandUpcE, gtinCandidates, gtinKey, kcalPerPackage, offIndex, OFF_COLUMNS, packageGrams, parseOffLine, parseUsdaLine, tidyBrand, tidyUsdaName,
} from '../src/barcodes/parse.js';
import { unzipFirstEntry } from '../src/barcodes/unzip.js';
import { openMirror } from '../src/barcodes/mirror.js';
import { lookupUpc } from '../src/routes/barcode.js';
import { login, makeApp, seedUser } from './helpers.js';

// ---------- fixtures ----------
const usdaFood = (o: Record<string, unknown>) => JSON.stringify({
  foodClass: 'Branded', description: 'CHUNKY PEANUT BUTTER SPREAD, CHUNKY', brandName: 'SKIPPY', brandOwner: 'Hormel Foods Corporation ',
  gtinUpc: '037600114820', packageWeight: '16 OZ/1 LB/454 g', servingSize: 32, servingSizeUnit: 'g', brandedFoodCategory: 'Nut & Seed Butters',
  foodNutrients: [{ nutrient: { id: 1003, unitName: 'g' }, amount: 21.9 }, { nutrient: { id: 1008, unitName: 'kcal' }, amount: 656 }],
  labelNutrients: { calories: { value: 210 } }, ...o,
});
const usdaFile = (foods: string[]) => `{"BrandedFoods": [\n${foods.join(',\n')}]}\n`;

const offRow = (o: Partial<Record<(typeof OFF_COLUMNS)[number], string>>) => {
  const cols = ['url', ...OFF_COLUMNS, 'extra'];
  const v: Record<string, string> = { code: '0037600114820', product_name: 'Creamy Peanut Butter &amp; Honey', brands: 'Skippy,Hormel', quantity: '16 oz (454 g)',
    countries_tags: 'en:united-states', categories_tags: 'en:spreads,en:nut-butters', product_quantity: '454', 'energy-kcal_100g': '600',
    'energy-kj_100g': '', image_small_url: 'https://images.openfoodfacts.org/x.jpg', url: 'u', extra: 'x', ...o };
  return { header: cols.join('\t'), line: cols.map((c) => v[c] ?? '').join('\t') };
};

/** Minimal single-entry zip (local header + deflate data + junk standing in for the central directory). */
function zipOf(name: string, content: string): Buffer {
  const data = zlib.deflateRawSync(Buffer.from(content));
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0, 6); h.writeUInt16LE(8, 8);
  h.writeUInt32LE(data.length, 18); h.writeUInt32LE(Buffer.byteLength(content), 22); h.writeUInt16LE(name.length, 26); h.writeUInt16LE(0, 28);
  return Buffer.concat([h, Buffer.from(name), data, Buffer.from('PK\x01\x02central-directory-junk')]);
}

function fakeFetch(routes: Record<string, () => Response>, calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const hit = Object.entries(routes).find(([k]) => url.startsWith(k));
    if (!hit) throw new Error(`unexpected fetch ${url}`);
    return hit[1]();
  }) as typeof fetch;
}
const bytes = (b: Buffer | string) => () => new Response(typeof b === 'string' ? b : new Uint8Array(b));

// ---------- parse ----------
describe('gtin', () => {
  it('normalizes UPC-A, EAN-13 and GTIN-14 to one key', () => {
    expect(gtinKey('037600114820')).toBe('37600114820');
    expect(gtinKey('0037600114820')).toBe('37600114820');
    expect(gtinKey('00037600114820')).toBe('37600114820');
  });
  it('expands UPC-E', () => {
    expect(expandUpcE('04963406')).toBe('049000006346'); // Coca-Cola 12 oz can
    expect(expandUpcE('01234505')).toBe('012000003455');
    expect(expandUpcE('01234565')).toBe('012345000065');
    expect(expandUpcE('51234505')).toBeNull();
    expect(gtinCandidates('04963406')).toEqual(['4963406', '49000006346']);
  });
});

describe('package math', () => {
  it('reads package sizes, preferring the metric figure', () => {
    expect(packageGrams('16 OZ/1 LB/454 g')).toBe(454);
    expect(packageGrams('3 lbs/1.36 kg/48 oz')).toBe(1360);
    expect(packageGrams('12 FL OZ/355 ML')).toBe(355);
    expect(packageGrams('0.5 GAL/1.89 L')).toBeCloseTo(1890);
    expect(packageGrams('2 x 1.5 L')).toBe(3000);
    expect(Math.round(packageGrams('15.5 oz')!)).toBe(439);
    expect(packageGrams('1 CAKE')).toBeNull();
    expect(packageGrams(null)).toBeNull();
  });
  it('computes package calories and rejects nonsense', () => {
    expect(kcalPerPackage(656, 454)).toBe(2978);
    expect(kcalPerPackage(null, 454)).toBeNull();
    expect(kcalPerPackage(5000, 100)).toBeNull(); // > 950 kcal/100 g is a data error
    expect(kcalPerPackage(400, 0)).toBeNull();
  });
});

describe('names', () => {
  it('tidies USDA descriptions and brands', () => {
    expect(tidyUsdaName('CHUNKY PEANUT BUTTER SPREAD, CHUNKY', 'Skippy')).toBe('Chunky Peanut Butter Spread');
    expect(tidyUsdaName('SKIPPY, CREAMY PEANUT BUTTER', 'Skippy')).toBe('Creamy Peanut Butter');
    expect(tidyUsdaName('GRANOLA, CINNAMON, RAISIN, CINNAMON, RAISIN', null)).toBe('Granola, Cinnamon, Raisin');
    expect(tidyUsdaName("JULIE'S ORGANIC ICE CREAM WITH BERRIES", null)).toBe("Julie's Organic Ice Cream with Berries");
    expect(tidyBrand('Hormel Foods Corporation ')).toBe('Hormel Foods');
    expect(tidyBrand('Wal-Mart Stores, Inc.')).toBe('Wal-Mart Stores');
    expect(tidyBrand('')).toBeNull();
  });
});

describe('source rows', () => {
  it('parses a USDA line', () => {
    expect(parseUsdaLine(usdaFood({}) + ',')).toEqual({
      gtin: '37600114820', name: 'Chunky Peanut Butter Spread', brand: 'Skippy', quantity: '16 oz', category: 'food', kcal: 2978, image: null,
    });
    expect(parseUsdaLine('{"BrandedFoods": [')).toBeNull();
    expect(parseUsdaLine(usdaFood({}) + ']}')?.gtin).toBe('37600114820'); // last line of the file
    expect(parseUsdaLine(usdaFood({ brandedFoodCategory: 'Water' }))?.category).toBe('water');
    expect(parseUsdaLine(usdaFood({ packageWeight: '12.0 OZA' }))).toMatchObject({ quantity: '12 fl oz', kcal: Math.round(656 * 12 * 29.5735 / 100) });
    // no energy nutrient: falls back to label calories per serving
    expect(parseUsdaLine(usdaFood({ foodNutrients: [] }))?.kcal).toBe(Math.round((210 * 100) / 32 * 454 / 100));
  });
  it('parses an Open Food Facts line with a country filter', () => {
    const { header, line } = offRow({});
    const idx = offIndex(header);
    expect(parseOffLine(line, idx, ['en:united-states'])).toEqual({
      gtin: '37600114820', name: 'Creamy Peanut Butter & Honey', brand: 'Skippy', quantity: '16 oz (454 g)', category: 'food', kcal: 2724,
      image: 'https://images.openfoodfacts.org/x.jpg',
    });
    expect(parseOffLine(offRow({ countries_tags: 'en:france' }).line, idx, ['en:united-states'])).toBeNull();
    expect(parseOffLine(offRow({ countries_tags: 'en:france' }).line, idx, [])?.gtin).toBe('37600114820');
    expect(parseOffLine(offRow({ product_name: '' }).line, idx, [])).toBeNull();
    expect(() => offIndex('code\tproduct_name')).toThrow(/missing column/);
  });
});

describe('unzipFirstEntry', () => {
  it('streams the first entry and ignores the rest of the archive', async () => {
    const content = usdaFile([usdaFood({}), usdaFood({ gtinUpc: '1' })]);
    const out = await unzipFirstEntry(Readable.from([zipOf('a.json', content)]));
    let s = '';
    for await (const c of out) s += c;
    expect(s).toBe(content);
  });
  it('rejects non-zip input', async () => {
    await expect(unzipFirstEntry(Readable.from([Buffer.alloc(40)]))).rejects.toThrow(/not a zip/);
  });
});

// ---------- mirror ----------
interface FixtureState { usdaVersion: string; foods: string[]; offLines: string[]; offStatus: number }

/** Fake USDA + OFF download servers; mutate `state` between refreshes to change what they serve. */
function mirrorFixture(over: Partial<FixtureState> = {}) {
  const { header } = offRow({});
  const state: FixtureState = {
    usdaVersion: '2026-04-30',
    foods: [usdaFood({}), usdaFood({ gtinUpc: '04963406', description: 'COLA', brandName: 'COCA-COLA', packageWeight: '12 fl oz/355 mL', foodNutrients: [{ nutrient: { id: 1008, unitName: 'kcal' }, amount: 39 }] })],
    offLines: [
      offRow({}).line,
      offRow({ code: '0012000161155', product_name: 'Life Wtr', brands: 'LFE', categories_tags: 'en:waters', 'energy-kcal_100g': '0' }).line,
      offRow({ code: '3017620422003', product_name: 'Nutella', countries_tags: 'en:france' }).line,
    ],
    offStatus: 200,
    ...over,
  };
  const calls: string[] = [];
  const fetcher = fakeFetch({
    'https://usda.test/index': () => new Response(`<a href="/fdc-datasets/FoodData_Central_branded_food_json_2025-12-18.zip">old</a><a href="/fdc-datasets/FoodData_Central_branded_food_json_${state.usdaVersion}.zip">new</a>`),
    'https://usda.test/files/': () => new Response(new Uint8Array(zipOf('f.json', usdaFile(state.foods)))),
    'https://off.test/': () => state.offStatus !== 200 ? new Response('nope', { status: state.offStatus })
      : new Response(new Uint8Array(zlib.gzipSync([header, ...state.offLines].join('\n') + '\n'))),
  }, calls);
  return { calls, state, opts: { fetcher, urls: { usdaIndex: 'https://usda.test/index', usdaBase: 'https://usda.test/files/', off: 'https://off.test/x.csv.gz' } } };
}

describe('offline mirror', () => {
  it('imports both sources, merges on lookup, and skips work that is not due', async () => {
    const fx = mirrorFixture();
    const m = openMirror(':memory:', fx.opts);
    expect(m.lookup('037600114820')).toBeNull();
    await m.refresh();
    // Merged: OFF's human name + photo, USDA's calories.
    expect(m.lookup('037600114820')).toEqual({
      name: 'Creamy Peanut Butter & Honey', brand: 'Skippy', quantity: '16 oz (454 g)', category: 'food', kcal: 2978,
      image: 'https://images.openfoodfacts.org/x.jpg', source: 'usda+off',
    });
    expect(m.lookup('0037600114820')?.source).toBe('usda+off'); // EAN-13 form
    expect(m.lookup('049000006346')).toMatchObject({ name: 'Cola', brand: 'Coca-Cola', kcal: 138, source: 'usda' }); // UPC-A of a UPC-E entry
    expect(m.lookup('012000161155')).toMatchObject({ category: 'water', source: 'off' });
    expect(m.lookup('3017620422003')).toBeNull(); // filtered to US products
    const st = m.status();
    expect(st.products).toBe(3);
    expect(st.sources.map((s) => [s.source, s.rows, s.version, s.error])).toEqual([['usda', 2, '2026-04-30', null], ['off', 2, expect.any(String), null]]);

    // Same USDA release and a fresh OFF import: only the release page is fetched.
    fx.calls.length = 0;
    await m.refresh();
    expect(fx.calls).toEqual(['https://usda.test/index']);
    m.close();
  });

  it('keeps the previous data when a refresh fails or yields nothing', async () => {
    const fx = mirrorFixture();
    const m = openMirror(':memory:', fx.opts);
    await m.refresh();
    fx.state.offStatus = 500;
    await m.refresh({ sources: ['off'], force: true });
    expect(m.status().sources[1]).toMatchObject({ rows: 2, error: expect.stringMatching(/500/) });
    expect(m.lookup('012000161155')?.source).toBe('off');

    fx.state.usdaVersion = '2026-10-30';
    fx.state.foods = [];
    await m.refresh({ sources: ['usda'] });
    expect(m.status().sources[0]).toMatchObject({ rows: 2, version: '2026-04-30', error: expect.stringMatching(/no products/) });
    expect(m.lookup('049000006346')?.source).toBe('usda');

    // A good release clears the error and replaces the table.
    fx.state.foods = [usdaFood({ gtinUpc: '011110045706', description: 'FROSTED COOKIES', brandName: 'KROGER' })];
    await m.refresh({ sources: ['usda'] });
    expect(m.status().sources[0]).toMatchObject({ rows: 1, version: '2026-10-30', error: null });
    expect(m.lookup('049000006346')).toBeNull();
    m.close();
  });

  it('runs one refresh at a time and does nothing when disabled', async () => {
    const fx = mirrorFixture();
    const m = openMirror(':memory:', fx.opts);
    const a = m.refresh(), b = m.refresh();
    expect(a).toBe(b);
    expect(m.running()).toBe(true);
    await a;
    expect(m.running()).toBe(false);
    const off = openMirror(':memory:', { ...fx.opts, enabled: false });
    await off.refresh();
    expect(off.status()).toMatchObject({ enabled: false, products: 0 });
    m.close(); off.close();
  });
});

// ---------- lookup chain ----------
describe('barcode lookup chain', () => {
  const offMiss = () => new Response('{"status":0}', { status: 404 });

  it('answers from the mirror without touching the network', async () => {
    const fx = mirrorFixture();
    const barcodes = openMirror(':memory:', fx.opts);
    await barcodes.refresh();
    const { app, db } = await makeApp({ barcodes });
    await seedUser(db, 'a@x.test');
    const a = await login(app, 'a@x.test');
    const r = await a.get('/api/barcode/037600114820');
    expect(r.json.product).toMatchObject({ found: true, name: 'Creamy Peanut Butter & Honey', kcal: 2978, source: 'usda+off' });
    expect(r.json.own).toBeNull();
  });

  it('falls through the Open Food Facts family to UPCitemdb and caches the answer', async () => {
    const { db } = await makeApp();
    const calls: string[] = [];
    const fetcher = fakeFetch({
      'https://world.openfoodfacts.org/': offMiss, 'https://world.openproductsfacts.org/': offMiss,
      'https://world.openbeautyfacts.org/': offMiss, 'https://world.openpetfoodfacts.org/': offMiss,
      'https://api.upcitemdb.com/': () => Response.json({ code: 'OK', total: 1, items: [{ title: 'Energizer AA Batteries 24 pack', brand: 'Energizer', category: 'Electronics > Batteries', images: ['http://x', 'https://img/aa.jpg'] }] }),
    }, calls);
    const p = await lookupUpc({ db, barcodes: null } as never, '039800013200', fetcher);
    expect(p).toMatchObject({ found: true, name: 'AA Batteries 24 pack', brand: 'Energizer', category: 'power', image: 'https://img/aa.jpg', source: 'upcitemdb' });
    expect(calls).toHaveLength(5);
    calls.length = 0;
    expect((await lookupUpc({ db, barcodes: null } as never, '039800013200', fetcher)).source).toBe('upcitemdb');
    expect(calls).toHaveLength(0); // cached
  });

  it('prefers Open Food Facts when several sources answer, and computes calories', async () => {
    const { db } = await makeApp();
    const hit = (name: string) => () => Response.json({ status: 1, product: { product_name: name, brands: 'B', product_quantity: '200', nutriments: { 'energy-kcal_100g': 500 } } });
    const fetcher = fakeFetch({
      'https://world.openfoodfacts.org/': hit('Food thing'), 'https://world.openproductsfacts.org/': hit('Product thing'),
      'https://world.openbeautyfacts.org/': offMiss, 'https://world.openpetfoodfacts.org/': offMiss,
    });
    expect(await lookupUpc({ db, barcodes: null } as never, '1234567890128', fetcher)).toMatchObject({ name: 'Food thing', kcal: 1000, source: 'off-online' });
  });

  it('when offline: no UPCitemdb call, nothing cached, answers fast', async () => {
    const { db } = await makeApp();
    const calls: string[] = [];
    const fetcher = (async (u: string) => { calls.push(String(u)); throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    const p = await lookupUpc({ db, barcodes: null } as never, '111111111117', fetcher);
    expect(p.found).toBe(false);
    expect(calls.some((c) => c.includes('upcitemdb'))).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM barcode_cache').get()).toEqual({ n: 0 });
  });

  it('a UPCitemdb quota error is not cached as a miss', async () => {
    const { db } = await makeApp();
    const fetcher = fakeFetch({
      'https://world.openfoodfacts.org/': offMiss, 'https://world.openproductsfacts.org/': offMiss,
      'https://world.openbeautyfacts.org/': offMiss, 'https://world.openpetfoodfacts.org/': offMiss,
      'https://api.upcitemdb.com/': () => new Response('{"code":"EXCEED_LIMIT"}', { status: 429 }),
    });
    expect((await lookupUpc({ db, barcodes: null } as never, '222222222224', fetcher)).found).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM barcode_cache').get()).toEqual({ n: 0 });
  });
});
