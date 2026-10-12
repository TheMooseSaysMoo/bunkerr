/**
 * Pure helpers for the offline barcode mirror: GTIN normalization and turning USDA FoodData
 * Central / Open Food Facts rows into one product shape. No I/O here so it's easy to test.
 */

export interface MirrorRow {
  gtin: string;
  name: string;
  brand: string | null;
  quantity: string | null;
  category: string;
  /** Calories in the whole package, when the source gives both energy density and package size. */
  kcal: number | null;
  image: string | null;
}

// ---------------- GTIN ----------------

/** Canonical key: digits only, leading zeros stripped, so UPC-A, EAN-13 and GTIN-14 of one product match. */
export const gtinKey = (code: string) => code.replace(/\D/g, '').replace(/^0+/, '');

/** UPC-E (8 digits, number system 0/1) to UPC-A. Returns null if it isn't a plausible UPC-E. */
export function expandUpcE(code: string): string | null {
  if (!/^[01]\d{7}$/.test(code)) return null;
  const ns = code[0], d = code.slice(1, 7), check = code[7];
  const last = d[5];
  let body: string;
  if (last <= '2') body = d.slice(0, 2) + last + '0000' + d.slice(2, 5);
  else if (last === '3') body = d.slice(0, 3) + '00000' + d.slice(3, 5);
  else if (last === '4') body = d.slice(0, 4) + '00000' + d[4];
  else body = d.slice(0, 5) + '0000' + last;
  return ns + body + check;
}

/** Key a source row is stored under: 8-digit UPC-E codes are stored as their UPC-A so either scan form finds them. */
export function storeKey(code: string): string {
  const digits = code.replace(/\D/g, '');
  const upcA = digits.length === 8 ? expandUpcE(digits) : null;
  return gtinKey(upcA ?? digits);
}

/** Keys to try for a scanned code: as-is, plus the UPC-A expansion when it looks like UPC-E. */
export function gtinCandidates(code: string): string[] {
  const digits = code.replace(/\D/g, '');
  const keys = new Set([gtinKey(digits)]);
  const upcA = digits.length === 8 ? expandUpcE(digits) : null;
  if (upcA) keys.add(gtinKey(upcA));
  keys.delete('');
  return [...keys];
}

// ---------------- text ----------------

const SMALL = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with', 'w/']);

/** "CHUNKY PEANUT BUTTER" -> "Chunky Peanut Butter"; leaves mixed-case input alone. */
export function titleCase(s: string): string {
  if (/[a-z]/.test(s)) return s.trim();
  return s.toLowerCase().trim().split(/\s+/).map((w, i) =>
    i > 0 && SMALL.has(w) ? w : w.replace(/(^[^a-z]*|-)([a-z])/g, (_m, pre: string, c: string) => pre + c.toUpperCase()),
  ).join(' ');
}

const ENTITIES: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
export const decodeEntities = (s: string) =>
  s.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
    return ENTITIES[e.toLowerCase()] ?? m;
  });

const CORP = /,?\s+(inc\.?|incorporated|llc\.?|l\.l\.c\.|co\.?|corp\.?|corporation|company|ltd\.?|limited|lp|l\.p\.)$/i;
export function tidyBrand(s: string | null | undefined): string | null {
  let b = (s ?? '').trim();
  if (!b) return null;
  for (let i = 0; i < 3 && CORP.test(b); i++) b = b.replace(CORP, '').trim();
  return b ? titleCase(b) : null;
}

/**
 * USDA descriptions repeat the brand and the variant: "SKIPPY, CHUNKY PEANUT BUTTER SPREAD, CHUNKY".
 * Drops a leading brand and any comma part already said earlier, then title-cases.
 */
export function tidyUsdaName(description: string, brand: string | null): string {
  let parts = description.split(/,\s*/).map((p) => p.trim()).filter(Boolean);
  if (brand && parts.length > 1 && parts[0].toLowerCase() === brand.toLowerCase()) parts = parts.slice(1);
  const kept: string[] = [];
  for (const p of parts) {
    const seen = kept.join(' ').toLowerCase();
    if (!seen.includes(p.toLowerCase())) kept.push(p);
  }
  return titleCase(kept.join(', ')).slice(0, 160);
}

// ---------------- package size ----------------

const UNIT_GRAMS: Record<string, number> = {
  mg: 0.001, g: 1, gr: 1, gm: 1, grams: 1, kg: 1000,
  ml: 1, cl: 10, dl: 100, l: 1000, lt: 1000, ltr: 1000, liter: 1000, litre: 1000,
  oz: 28.3495, onz: 28.3495, oza: 29.5735, fz: 29.5735, ounce: 28.3495, ounces: 28.3495, lb: 453.592, lbs: 453.592, pound: 453.592, pounds: 453.592,
  'fl oz': 29.5735, floz: 29.5735, gal: 3785.41, gallon: 3785.41, qt: 946.353, quart: 946.353, pt: 473.176, pint: 473.176,
};
const METRIC = new Set(['mg', 'g', 'gr', 'gm', 'grams', 'kg', 'ml', 'cl', 'dl', 'l', 'lt', 'ltr', 'liter', 'litre']);

/** Grams (or mL, treated as grams) in a package description like "15.5 oz/440 g" or "2 x 1.5 L". */
export function packageGrams(s: string | null | undefined): number | null {
  if (!s) return null;
  const re = /(?:(\d+(?:\.\d+)?)\s*[x×]\s*)?(\d+(?:[.,]\d+)?)\s*(fl\.?\s*oz|[a-z]+)\b/gi;
  let metric: number | null = null, other: number | null = null;
  for (const m of s.matchAll(re)) {
    const unit = /^fl/i.test(m[3]) ? 'fl oz' : m[3].toLowerCase();
    const per = UNIT_GRAMS[unit];
    if (!per) continue;
    const g = (m[1] ? Number(m[1]) : 1) * Number(m[2].replace(',', '.')) * per;
    if (!(g > 0)) continue;
    if (METRIC.has(unit)) { metric ??= g; } else { other ??= g; }
  }
  const g = metric ?? other;
  return g && g <= 100_000 ? g : null;
}

/** Package calories from energy per 100 g/mL. Null when either input is missing or the result is implausible. */
export function kcalPerPackage(kcalPer100: number | null | undefined, grams: number | null | undefined): number | null {
  if (kcalPer100 == null || grams == null || !(kcalPer100 >= 0) || kcalPer100 > 950 || !(grams > 0)) return null;
  const k = Math.round(kcalPer100 * grams / 100);
  return k > 0 && k <= 150_000 ? k : null;
}

/** First part of "16 OZ/1 LB/454 g", lower-cased: "16 oz". */
const shortQty = (s: string | null | undefined) => {
  const q = (s ?? '').split('/')[0].trim();
  return q ? q.toLowerCase().replace(/\s+/g, ' ').replace(/\bonz\b/, 'oz').replace(/\b(oza|fz)\b/, 'fl oz').replace(/^(\d+)\.0\b/, '$1').slice(0, 40) : null;
};

// ---------------- USDA FoodData Central (branded foods JSON, one food per line) ----------------

interface UsdaFood {
  gtinUpc?: string; description?: string; brandName?: string; brandOwner?: string; packageWeight?: string;
  servingSize?: number; servingSizeUnit?: string; brandedFoodCategory?: string; marketCountry?: string;
  foodNutrients?: { nutrient?: { id?: number; unitName?: string }; amount?: number }[];
  labelNutrients?: { calories?: { value?: number } };
}

export function usdaCategory(c: string | undefined): string {
  if (!c) return 'food';
  if (/^(water|bottled water)$/i.test(c.trim())) return 'water';
  if (/vitamin|supplement|medical|baby formula/i.test(c)) return /formula/i.test(c) ? 'food' : 'medical';
  return 'food';
}

/** One line of the FDC branded JSON (`{...},`) to a row; null for the wrapper lines or unusable foods. */
export function parseUsdaLine(line: string): MirrorRow | null {
  let s = line.trim();
  if (!s.startsWith('{"') || s.startsWith('{"BrandedFoods"')) return null;
  s = s.replace(/,$/, '');
  let f: UsdaFood;
  try { f = JSON.parse(s); } catch {
    try { f = JSON.parse(s.replace(/\]\s*\}$/, '')); } catch { return null; }
  }
  const gtin = storeKey(f.gtinUpc ?? '');
  if (gtin.length < 6 || !f.description) return null;
  const brand = tidyBrand(f.brandName) ?? tidyBrand(f.brandOwner);
  let per100: number | null = null;
  for (const id of [1008, 2047, 2048]) {
    const n = f.foodNutrients?.find((x) => x.nutrient?.id === id && (x.nutrient.unitName ?? 'kcal').toLowerCase() === 'kcal');
    if (n?.amount != null) { per100 = n.amount; break; }
  }
  const cal = f.labelNutrients?.calories?.value;
  if (per100 == null && cal != null && f.servingSize) per100 = (cal * 100) / f.servingSize;
  return {
    gtin,
    name: tidyUsdaName(f.description, brand),
    brand,
    quantity: shortQty(f.packageWeight),
    category: usdaCategory(f.brandedFoodCategory),
    kcal: kcalPerPackage(per100, packageGrams(f.packageWeight)),
    image: null,
  };
}

// ---------------- Open Food Facts (TSV export) ----------------

export const OFF_COLUMNS = ['code', 'product_name', 'brands', 'quantity', 'countries_tags', 'categories_tags', 'product_quantity', 'energy-kcal_100g', 'energy-kj_100g', 'image_small_url'] as const;
export type OffIndex = Record<(typeof OFF_COLUMNS)[number], number>;

export function offIndex(header: string): OffIndex {
  const cols = header.split('\t');
  const idx = {} as OffIndex;
  for (const c of OFF_COLUMNS) {
    const i = cols.indexOf(c);
    if (i < 0) throw new Error(`Open Food Facts export is missing column ${c}`);
    idx[c] = i;
  }
  return idx;
}

/** Maps Open Food Facts category tags onto Bunkerr categories. */
export function offCategory(tags = ''): string {
  if (/waters\b|spring-water|mineral-water/.test(tags)) return 'water';
  if (/dietary-supplements|medicines|first-aid/.test(tags)) return 'medical';
  return 'food';
}

const num = (s: string | undefined) => { const n = s ? Number(s) : NaN; return Number.isFinite(n) ? n : null; };

/** One TSV line to a row. `countries` is a list of tags like "en:united-states"; empty means keep everything. */
export function parseOffLine(line: string, idx: OffIndex, countries: string[]): MirrorRow | null {
  if (countries.length && !countries.some((c) => line.includes(c))) return null; // cheap prefilter before splitting
  const f = line.split('\t');
  if (f.length <= idx.image_small_url) return null;
  if (countries.length && !countries.some((c) => f[idx.countries_tags].split(',').includes(c))) return null;
  const gtin = storeKey(f[idx.code]);
  const name = decodeEntities(f[idx.product_name] ?? '').trim();
  if (gtin.length < 6 || !name) return null;
  const kj = num(f[idx['energy-kj_100g']]);
  const per100 = num(f[idx['energy-kcal_100g']]) ?? (kj != null ? kj / 4.184 : null);
  const quantity = decodeEntities(f[idx.quantity] ?? '').trim();
  const grams = num(f[idx.product_quantity]) ?? packageGrams(quantity);
  const image = f[idx.image_small_url]?.trim();
  return {
    gtin,
    name: name.slice(0, 160),
    brand: decodeEntities(f[idx.brands]?.split(',')[0] ?? '').trim() || null,
    quantity: quantity ? quantity.slice(0, 40) : null,
    category: offCategory(f[idx.categories_tags]),
    kcal: kcalPerPackage(per100, grams && grams <= 100_000 ? grams : null),
    image: image?.startsWith('https://') ? image : null,
  };
}
