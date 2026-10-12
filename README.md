# Bunkerr

Self-hosted emergency-prep tracker for households. Keep track of food, water, medical and other supplies, get warned before things expire, and know roughly how many days of food and water you have. Terminal-styled, mobile-first, installable on phones, and it keeps working offline.

## Features

- **Inventory by section:** food, water, medical, hygiene, power, tools, comms, garden and other, with expiry tiers, low-stock minimums, and *days of food / water* from calories and gallons.
- **Fast entry:**
  - **Barcode scanning** with an offline copy of USDA FoodData Central and Open Food Facts (~970k US products, calories filled in), plus online fallbacks.
  - **Quick add** with suggestions for ~170 common prep staples.
  - **Receipt / shelf photos** read by Claude (optional).
- **Power equipment:** power banks, battery backups, generators, with charge and maintenance reminders.
- **Gardens:** grid planner with planting, germination and harvest dates, and watering reminders.
- **Meshtastic:** node health (last heard, battery, signal) from your own MQTT broker (optional).
- **Armory:** firearms, modifications, ammunition with caliber matching, range log. Can be turned off per household; serials are masked.
- **Alerts:** a daily digest and urgent alerts to Discord, ntfy, email or a webhook router.
- **Households:** invite-only, with owner, member and viewer roles. People can belong to several households; data is isolated per household.
- **Linked households:** link with a household on someone else's Bunkerr server. Each side chooses what it shares (readiness summary, inventory, power, mesh status; never the armory). The two servers can also relay a shared Meshtastic channel between separate meshes.
- **Offline:** the app keeps a saved copy on each device, and changes made offline sync later without being applied twice.
- **Optional failover:** a standby server keeps a copy and takes over automatically through Cloudflare.

## Quick start

On a Linux host with Docker and Compose v2:

```sh
git clone https://github.com/<you>/bunkerr.git
cd bunkerr
./setup.sh
```

`setup.sh` creates `.env` with a random secret, prepares `data/`, builds and starts the container, and creates the first admin account. Then open the address you gave it.

For phones (app install, barcode camera) put it behind **HTTPS**: a reverse proxy such as Caddy, Nginx Proxy Manager or Traefik, or a Cloudflare Tunnel. See [Deploy](docs/03-deploy.md).

Update later with `./deploy.sh`, which pulls, rebuilds and restarts. Your `.env` and `data/` are never touched.

## Configuration

Everything lives in `.env`. Start from [`.env.example`](.env.example), which works as-is for a single server once `PUBLIC_URL` and `INTERNAL_SECRET` are set. Email, Discord and ntfy are configured inside the app. Optional features (photo import, Meshtastic, notification router, family portal, failover) are each off until you set their variables. Linked households work out of the box once `PUBLIC_URL` is a public https address.

Your data is one SQLite file in `data/`, with daily snapshots in `data/backups/`. See [Backup & restore](docs/07-backup-restore.md).

## Development

```sh
npm install
npm run cli -- create-admin you@example.com "Your Name" "Maple House"   # prompts for a password
npm run dev          # API on :8787, UI on http://localhost:5173
npm test             # server + offline tests (vitest)
npm run typecheck
npm run build        # dist-web/ + server/dist/
```

Node 22, Fastify, SQLite (better-sqlite3), Preact + Vite. See [Architecture](docs/02-architecture.md).

## Documentation

The docs live in [`docs/`](docs/) and are also shown inside the app under **Docs**:

1. [Using Bunkerr](docs/01-using-bunkerr.md)
2. [Architecture](docs/02-architecture.md)
3. [Deploy](docs/03-deploy.md)
4. [Failover (optional)](docs/04-failover.md)
5. [Meshtastic MQTT](docs/05-meshtastic-mqtt.md)
6. [Notifications](docs/06-notifications.md)
7. [Backup & restore](docs/07-backup-restore.md)
8. [Onboarding a household](docs/08-onboarding-a-household.md)
9. [Armory](docs/09-armory.md)
10. [Barcode lookups](docs/10-barcodes.md)
11. [Power equipment](docs/11-power.md)
12. [Offline](docs/12-offline.md)
13. [Linked households](docs/13-linked-households.md)

## Data sources

Barcode data comes from [USDA FoodData Central](https://fdc.nal.usda.gov/) (public domain) and [Open Food Facts](https://world.openfoodfacts.org/) (© Open Food Facts contributors, [ODbL](https://opendatacommons.org/licenses/odbl/1-0/)). Each instance downloads its own copy; none of that data is in this repository.

## License

Bunkerr is free software under the [GNU Affero General Public License v3.0](LICENSE) or later. You can use, modify and share it. If you run a modified version for other people over a network, you must offer them its source code.
