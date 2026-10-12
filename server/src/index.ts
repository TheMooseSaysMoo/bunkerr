import fs from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import { buildApp } from './app.js';
import { config } from './config.js';
import { openDb } from './db.js';
import { createHa } from './ha.js';
import { createNotifier, webhookRouterProvider, PROVIDERS } from './notify.js';
import { newIngestState, startMqtt } from './mesh/ingest.js';
import { claudeExtractor } from './routes/receipt.js';
import { startScheduler } from './scheduler.js';
import { createMailer } from './mailer.js';
import { openMirror, startMirrorSchedule } from './barcodes/mirror.js';

const dbFile = path.join(config.dataDir, 'bunkerr.db');
const db = openDb(dbFile);
const ha = createHa(db, config, dbFile);
const mailer = createMailer(db);
const notifier = createNotifier(db, PROVIDERS, config.webhookRouterUrl ? webhookRouterProvider(config.webhookRouterUrl) : null, mailer);
const mesh = newIngestState();
const extractor = config.anthropicKey ? claudeExtractor(config.anthropicKey, config.claudeModel) : null;

// The mirror only logs during refreshes, which start after `app` exists.
const barcodes = openMirror(path.join(config.dataDir, 'barcodes.db'), {
  enabled: config.barcodeMirror,
  countries: config.barcodeCountries,
  log: { info: (o, m) => app.log.info(o, m), warn: (o, m) => app.log.warn(o, m) },
});

const app = await buildApp({ db, ha, notifier, mesh, extractor, barcodes, mailer }, { logger: true });

if (fs.existsSync(config.webDir)) {
  await app.register(fastifyStatic, { root: config.webDir, wildcard: false });
  // SPA fallback (hash router, so this is mostly for direct hits like /index.html variants).
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || req.url.startsWith('/assets/')) return reply.status(404).send({ error: 'Not found' });
    return reply.sendFile('index.html');
  });
} else {
  app.log.warn({ webDir: config.webDir }, 'web build not found; API only (run `npm run build` or use `npm run dev`)');
}

ha.start(app.log);
const mqttClient = startMqtt(db, config, mesh, app.log);
const stopScheduler = config.schedulerEnabled ? startScheduler(db, ha, notifier, app.log) : () => {};
const stopMirror = config.schedulerEnabled && config.barcodeMirror ? startMirrorSchedule(barcodes, app.log) : () => {};

await app.listen({ port: config.port, host: config.host });
app.log.info({ node: config.nodeName, role: config.role, active: ha.isActive() }, 'bunkerr up');

const shutdown = async () => {
  stopScheduler();
  stopMirror();
  ha.stop();
  mqttClient?.end();
  await app.close();
  db.close();
  barcodes.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
