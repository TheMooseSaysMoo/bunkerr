import path from 'node:path';

const env = process.env;

export const config = {
  port: Number(env.PORT ?? 8787),
  host: env.HOST ?? '0.0.0.0',
  dataDir: path.resolve(env.DATA_DIR ?? './data'),
  /** Human name of this instance, shown in the status line (e.g. "home-server", "offsite"). */
  nodeName: env.NODE_NAME ?? 'dev',
  /** "primary" is active unless the standby reports it has been promoted; "standby" is active only when promoted. */
  role: (env.BUNKERR_ROLE ?? 'primary') as 'primary' | 'standby',
  /** Base URL of the other instance (failover pair), reachable privately, e.g. http://10.0.0.2:8787 or a Tailscale address. */
  peerUrl: env.PEER_URL ?? '',
  /** Shared secret for /api/internal/* (snapshot sync, promote/demote). Empty disables those routes. */
  internalSecret: env.INTERNAL_SECRET ?? '',
  /** Bearer token the family hub uses to create accounts (/api/hub/*). Empty disables those routes. */
  hubToken: env.HUB_TOKEN ?? '',
  publicUrl: (env.PUBLIC_URL ?? 'http://localhost:5173').replace(/\/$/, ''),
  /** Secure cookies need HTTPS. Defaults to on when PUBLIC_URL is https, so a plain-http LAN test still logs in. */
  cookieSecure: (env.COOKIE_SECURE ?? (/^https:/i.test(env.PUBLIC_URL ?? '') ? 'true' : 'false')) === 'true',
  anthropicKey: env.ANTHROPIC_API_KEY ?? '',
  claudeModel: env.CLAUDE_MODEL ?? 'claude-opus-5-5',
  /** Optional notification router that accepts Home Assistant-style webhooks: a base URL, or a full URL ending in the webhook path. */
  webhookRouterUrl: env.WEBHOOK_ROUTER_URL ?? '',
  mqttUrl: env.MQTT_URL ?? '',
  mqttUsername: env.MQTT_USERNAME ?? '',
  mqttPassword: env.MQTT_PASSWORD ?? '',
  /** Accept a self-signed certificate on an mqtts:// broker (your own broker only). */
  mqttTlsInsecure: (env.MQTT_TLS_INSECURE ?? 'false') === 'true',
  /** Topic filter(s), comma-separated. Only ".../json/..." topics are parsed; gateways need "JSON output enabled". */
  mqttTopics: (env.MQTT_TOPICS ?? 'msh/#').split(',').map((s) => s.trim()).filter(Boolean),
  docsDir: path.resolve(env.DOCS_DIR ?? './docs'),
  webDir: path.resolve(env.WEB_DIR ?? './dist-web'),
  schedulerEnabled: (env.SCHEDULER_ENABLED ?? 'true') === 'true',
  /** Offline barcode mirror (USDA + Open Food Facts, data/barcodes.db, refreshed nightly when due). */
  barcodeMirror: (env.BARCODE_MIRROR ?? 'on') !== 'off',
  /** Open Food Facts country tags kept in the mirror, comma-separated; "all" keeps every country. */
  barcodeCountries: (env.BARCODE_COUNTRIES ?? 'en:united-states').split(',').map((s) => s.trim()).filter((s) => s && s !== 'all'),
  /** Ask the online Open Food Facts family when the mirror misses. */
  barcodeOnline: (env.BARCODE_ONLINE ?? 'on') !== 'off',
  /** Last-resort UPCitemdb free tier (general merchandise; ~100 lookups/day). */
  upcitemdb: (env.UPCITEMDB ?? 'on') !== 'off',
};

export type Config = typeof config;
