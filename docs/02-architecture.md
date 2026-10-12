# Architecture

```
            phones / laptops (installable PWA, works offline)
                        │ https://bunkerr.example.com
                        ▼
        reverse proxy or Cloudflare Tunnel (HTTPS)
                        │
                        ▼
   ┌─────────────────────────────────────────────┐        optional standby on another host
   │ bunkerr container :8787                     │  sync  ┌──────────────────────────────┐
   │   Fastify API + web app                     │◄──────►│ bunkerr (standby) + watchdog │
   │   SQLite /data/bunkerr.db, barcodes.db      │ private│ promotes itself and switches │
   │   scheduler: digests, alerts, backups       │ network│ DNS if the primary is down   │
   └──────▲───────────────────────────┬──────────┘        └──────────────────────────────┘
          │ MQTT (optional)           │ Discord / ntfy / email / notification router
   Meshtastic gateways                ▼
   (Wi-Fi nodes uplinking JSON)   your phone
```

## Components

| Piece | Tech | Notes |
|---|---|---|
| API + web | Node 22, Fastify, TypeScript | one container, serves the built SPA |
| Storage | SQLite (WAL) in `/data/bunkerr.db` | one file, easy to back up and replicate |
| UI | Preact + Vite, PWA | hash routes (`#/garden/3`), offline shell cache |
| Auth | argon2id passwords, httpOnly `SameSite=Strict` session cookie, `X-Bunkerr` header on writes (CSRF) | invite-only signup |
| Tenancy | `household_id` on every row; the household always comes from the session, never from the request | covered by `server/test/tenancy.test.ts` |
| Mesh | MQTT subscriber, Meshtastic JSON topics | only nodes a household has claimed are stored |
| Photo import | Claude API (`claude-opus-5-5`, structured output) | review before save; monthly quota per household |
| Barcodes | offline mirror `/data/barcodes.db` (USDA FoodData Central + Open Food Facts US), then online Open Food Facts family, then UPCitemdb | household's own past entries take priority; see [Barcode lookups](10-barcodes.md) |
| Notifications | Discord webhook, ntfy, email (SMTP), optional Home Assistant-style webhook router | per household; daily digest + mesh alerts; email per person |
| Scheduler | node-cron, in process | runs only on the **active** instance |
| Linked households | server-to-server https with per-link bearer tokens (`/api/federation/*`) | each side pulls what the other shares every 5 min and keeps the last copy; optional Meshtastic channel relay. See [Linked households](13-linked-households.md) |

## Repository layout

```
server/src/          API (routes/), auth & tenancy, scheduler, failover (ha.ts), mesh ingest, barcodes/, mailer
server/test/         vitest: tenancy isolation, logic, ingest, digest
web/src/             Preact views, offline/ (saved copy + outbox), theme.css (terminal look)
docs/                these pages (rendered in-app)
deploy/              mosquitto config, failover scripts (watchdog / promote / failback)
setup.sh, deploy.sh  first-run setup and git-based updates
```

## Data model (short)

`users` ⟷ `memberships(role)` ⟷ `households`. Tenant tables: `items`, `item_events`, `gardens`, `plantings`, `plants` (household_id NULL = built-in catalogue), `mesh_nodes`, `mesh_telemetry` (30-day retention), `settings`, `notifications` (dedupe log), `receipt_usage`, `links` / `link_codes` (linked households). Schema migrations are applied automatically at startup (`PRAGMA user_version`).

## Local development

```sh
npm install
npm run cli -- create-admin you@example.com "Your Name" "Maple House"
npm run dev        # API on :8787, UI on http://localhost:5173
npm test
```
