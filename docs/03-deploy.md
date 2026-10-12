# Deploy

Bunkerr runs as one Docker container with its data in a single SQLite file. Any Linux host with Docker works: a home server, a NAS (Unraid, TrueNAS, Synology with Container Manager), a small VPS or a Raspberry Pi 4/5.

## Requirements

- Docker with Compose v2 (`docker compose`).
- About 300 MB of RAM (up to ~600 MB briefly during the monthly barcode refresh) and ~500 MB of disk, plus your data.
- **HTTPS for real use.** Phones only install it as an app, use the camera for barcodes, and keep secure logins over HTTPS (or on `localhost`). A plain `http://LAN-IP:8787` is fine for trying it out.

## Quick start

```sh
git clone https://github.com/<you>/bunkerr.git
cd bunkerr
./setup.sh
```

`setup.sh`:
1. creates `.env` from `.env.example` with a random `INTERNAL_SECRET`, and asks for the address and timezone,
2. makes `data/` owned by uid 1000 (the app's user inside the container),
3. builds and starts the container and waits for `/healthz`,
4. creates the first admin account. It asks for a password, minimum 10 characters.

Then open the address and log in. **Keep a copy of `.env`.** `INTERNAL_SECRET` encrypts the saved SMTP password.

### By hand

```sh
cp .env.example .env && $EDITOR .env          # set PUBLIC_URL, TZ and INTERNAL_SECRET (openssl rand -hex 32)
mkdir -p data && sudo chown 1000:1000 data
docker compose up -d --build
docker compose exec bunkerr node server/dist/cli.js create-admin you@example.com "Your Name" "Your household"
```

## HTTPS

Put any reverse proxy in front of port 8787 and set `PUBLIC_URL` to the https address. Some common setups:

- **Caddy** (gets certificates automatically):
  ```
  bunkerr.example.com {
      reverse_proxy 127.0.0.1:8787
      request_body max_size 16MB
  }
  ```
- **Nginx Proxy Manager / Traefik / nginx:** forward to `http://<host>:8787`, with websockets not required. Allow request bodies up to 16 MB for receipt photos.
- **Cloudflare Tunnel** (no open ports): `cloudflared` with an ingress rule `bunkerr.example.com → http://localhost:8787`. The failover setup in [Failover](04-failover.md) builds on this.

If the proxy runs on the same host, set `BUNKERR_BIND=127.0.0.1:8787` so the app port isn't reachable from the LAN directly.

Bunkerr trusts `X-Forwarded-*` from the proxy and uses `CF-Connecting-IP` for rate limits when it's behind Cloudflare.

## Updating

```sh
./deploy.sh
```

This refuses to run if the checkout has local changes (so nothing gets silently overwritten). Otherwise it fetches, resets to `origin/main`, rebuilds, restarts and waits for `/healthz`. `.env` and `data/` are gitignored and never touched. Database migrations run automatically at startup.

If you run your own fork, push to it and run `./deploy.sh` on the server. Set `BRANCH=` to deploy another branch.

## Admin CLI

```sh
docker compose exec bunkerr node server/dist/cli.js create-admin you@example.com "Name" "Household"
docker compose exec bunkerr node server/dist/cli.js reset-password someone@example.com
docker compose exec bunkerr node server/dist/cli.js invite "Mom & Dad"            # new-household invite link
docker compose exec bunkerr node server/dist/cli.js barcodes-refresh [usda|off]  # rebuild the offline barcode copy
```

## Optional features

| Feature | Turn on with |
|---|---|
| Email alerts and invites | Settings → instance admin → email (SMTP) |
| Discord / ntfy alerts | Settings → alerts & notifications (per household) |
| Receipt / shelf photo import | `ANTHROPIC_API_KEY` in `.env`, then `docker compose up -d` (a restart doesn't reload `.env`; the container must be recreated) |
| Meshtastic node health | `MQTT_URL` etc. See [Meshtastic MQTT](05-meshtastic-mqtt.md) |
| Webhook router (anything that takes Home Assistant-style webhooks) | `WEBHOOK_ROUTER_URL` |
| Account creation from a family portal | `HUB_TOKEN`. See [Onboarding](08-onboarding-a-household.md) |
| Second server with automatic failover | [Failover](04-failover.md) |

## Notes for NAS users

- **Unraid:** clone into `/mnt/user/appdata/bunkerr` (keeps the data on the cache pool), and run the commands from the terminal. Unraid's `/root` doesn't persist across reboots, so keep any git deploy key under `/mnt/user/appdata/`.
- **Synology / TrueNAS:** make sure the `data` folder is writable by uid 1000, or adjust the folder's permissions in the NAS UI.
