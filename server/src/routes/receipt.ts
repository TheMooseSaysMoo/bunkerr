import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';
import { HttpError, requireHousehold } from '../auth.js';
import { config } from '../config.js';
import { getSettings } from '../settings.js';
import { CATEGORIES } from './inventory.js';
import { parse, todayIn } from '../util.js';

export const extractedItem = z.object({
  name: z.string().describe('Short generic product name a person would recognise, e.g. "Black beans, canned 15oz"'),
  qty: z.number().describe('Number of units bought/visible'),
  unit: z.string().describe('Unit such as ea, can, box, bottle, lb, oz, gal, pack'),
  category: z.enum(CATEGORIES),
  expires_on: z.string().nullable().describe('YYYY-MM-DD only if a date is printed/visible; otherwise null'),
  notes: z.string().describe('Brand or other useful detail, or empty string'),
});
const extraction = z.object({ items: z.array(extractedItem), warnings: z.array(z.string()) });
export type Extraction = z.infer<typeof extraction>;

export type Extractor = (imageBase64: string, mediaType: 'image/jpeg' | 'image/png' | 'image/webp', mode: 'receipt' | 'shelf', today: string) => Promise<Extraction>;

const SYSTEM = `You turn photos into household emergency-supply inventory rows for an app called Bunkerr.
For a receipt: list each purchased product line once with its quantity. Skip non-products (tax, totals, bags, coupons, fees, deposits). Expand cryptic receipt abbreviations into plain names when you are reasonably confident; otherwise keep the abbreviation and add a warning.
For a shelf/pantry photo: list each distinct product you can identify and count visible units. Read printed best-by/expiry dates only when legible.
Never invent expiry dates — use null when none is visible. Add a short warning for anything uncertain (illegible lines, guessed counts).`;

export function claudeExtractor(apiKey: string, model: string): Extractor {
  const client = new Anthropic({ apiKey });
  return async (data, mediaType, mode, today) => {
    const res = await client.beta.messages.parse({
      model,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SYSTEM,
      output_config: { effort: 'low', format: betaZodOutputFormat(extraction) },
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
          { type: 'text', text: `This is a ${mode === 'receipt' ? 'store receipt' : 'photo of a shelf/pantry'}. Today is ${today}. Extract the items.` },
        ],
      }],
    });
    if (res.stop_reason === 'refusal') throw new HttpError(422, 'The photo could not be processed');
    if (res.stop_reason === 'max_tokens') throw new HttpError(422, 'Too many items in one photo — try a closer crop');
    if (!res.parsed_output) throw new HttpError(502, 'Could not read items from the photo');
    return res.parsed_output;
  };
}

export default async function receiptRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;

  app.get('/api/receipt/quota', async (req) => {
    const hh = requireHousehold(req);
    const month = new Date().toISOString().slice(0, 7);
    const used = (db.prepare('SELECT count FROM receipt_usage WHERE household_id=? AND month=?').get(hh, month) as { count: number } | undefined)?.count ?? 0;
    const quota = (db.prepare('SELECT receipt_quota FROM households WHERE id=?').get(hh) as { receipt_quota: number }).receipt_quota;
    return { enabled: !!deps.extractor, used, quota };
  });

  app.post('/api/receipt', { bodyLimit: 12 * 1024 * 1024, config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (req) => {
    const hh = requireHousehold(req, 'member');
    if (!deps.extractor) throw new HttpError(503, 'Photo import is not configured (ANTHROPIC_API_KEY missing)');
    const body = parse(z.object({
      image: z.string().min(100).max(11_000_000),
      mediaType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
      mode: z.enum(['receipt', 'shelf']).default('receipt'),
    }), req.body);

    const month = new Date().toISOString().slice(0, 7);
    const claimed = db.transaction(() => {
      const quota = (db.prepare('SELECT receipt_quota FROM households WHERE id=?').get(hh) as { receipt_quota: number }).receipt_quota;
      const used = (db.prepare('SELECT count FROM receipt_usage WHERE household_id=? AND month=?').get(hh, month) as { count: number } | undefined)?.count ?? 0;
      if (used >= quota) return false;
      db.prepare(`INSERT INTO receipt_usage (household_id,month,count) VALUES (?,?,1) ON CONFLICT(household_id,month) DO UPDATE SET count=count+1`).run(hh, month);
      return true;
    })();
    if (!claimed) throw new HttpError(429, 'Monthly photo-import quota reached for this household');

    try {
      const today = todayIn(getSettings(db, hh).timezone);
      const out = await deps.extractor(body.image, body.mediaType, body.mode, today);
      const items = out.items.map((i) => ({ ...i, expires_on: i.expires_on && /^\d{4}-\d{2}-\d{2}$/.test(i.expires_on) ? i.expires_on : null }));
      return { items, warnings: out.warnings };
    } catch (e) {
      db.prepare('UPDATE receipt_usage SET count=MAX(0,count-1) WHERE household_id=? AND month=?').run(hh, month);
      if (e instanceof HttpError) throw e;
      req.log.error(e, 'receipt extraction failed');
      throw new HttpError(502, 'Photo import failed — try again');
    }
  });
}
