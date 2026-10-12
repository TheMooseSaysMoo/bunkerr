import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import type { DB } from './db.js';
import type { Ha } from './ha.js';
import type { Notifier } from './notify.js';
import type { IngestState } from './mesh/ingest.js';
import type { Extractor } from './routes/receipt.js';
import type { Mirror } from './barcodes/mirror.js';
import { HttpError, loadCtx } from './auth.js';
import accountRoutes from './routes/account.js';
import householdRoutes from './routes/household.js';
import adminRoutes from './routes/admin.js';
import inventoryRoutes from './routes/inventory.js';
import barcodeRoutes from './routes/barcode.js';
import receiptRoutes from './routes/receipt.js';
import gardenRoutes from './routes/garden.js';
import meshRoutes from './routes/mesh.js';
import miscRoutes from './routes/misc.js';
import armoryRoutes from './routes/armory.js';
import hubRoutes from './routes/hub.js';
import accessRoutes from './routes/access.js';
import powerRoutes from './routes/power.js';
import emailRoutes from './routes/email.js';
import linkRoutes from './routes/links.js';
import type { Federation } from './federation/index.js';
import type { Mailer } from './mailer.js';
import { registerIdempotency } from './idempotency.js';

export interface AppDeps {
  db: DB;
  ha: Ha;
  notifier: Notifier;
  mesh: IngestState;
  extractor: Extractor | null;
  barcodes: Mirror | null;
  mailer: Mailer;
  federation: Federation;
}

export async function buildApp(deps: AppDeps, opts: { logger?: boolean; trustProxy?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: opts.trustProxy ?? true, bodyLimit: 1024 * 1024 });

  await app.register(cookie);
  await app.register(rateLimit, {
    global: true, max: 600, timeWindow: '1 minute',
    // Cloudflare sends the real client IP; fall back to the socket address.
    keyGenerator: (req) => String(req.headers['cf-connecting-ip'] ?? req.ip),
  });
  // Unsubscribe buttons and mail apps' one-click unsubscribe post form data; nothing reads it.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 4096 }, (_req, body, done) => done(null, body));
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 1024 * 1024 * 1024 }, (_req, body, done) => done(null, body));

  app.decorateRequest('ctx', null);
  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    req.ctx = loadCtx(deps.db, req);
    // CSRF: mutating API calls must carry a custom header that cross-site forms cannot set.
    // Internal and hub routes authenticate with a shared secret, linked servers with a bearer token, and
    // access-request decisions with a signed URL (a webhook router performs them), not the cookie, so CSRF doesn't apply.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !req.url.startsWith('/api/internal/') && !req.url.startsWith('/api/hub/') && !req.url.startsWith('/api/federation/') && !/^\/api\/access-requests\/\d+\/(approve|reject)\?/.test(req.url) && !req.url.startsWith('/api/email/unsubscribe?') && req.headers['x-bunkerr'] !== '1') {
      throw new HttpError(403, 'Missing X-Bunkerr header');
    }
  });

  registerIdempotency(app, deps.db);

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: err.message });
    req.log.error(err);
    return reply.status(500).send({ error: 'Internal error' });
  });

  for (const routes of [accountRoutes, householdRoutes, adminRoutes, inventoryRoutes, barcodeRoutes, receiptRoutes, gardenRoutes, meshRoutes, armoryRoutes, powerRoutes, emailRoutes, linkRoutes, hubRoutes, accessRoutes, miscRoutes]) {
    await app.register(async (scope) => routes(scope, deps));
  }
  return app;
}
