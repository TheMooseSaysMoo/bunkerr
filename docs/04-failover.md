# Failover (optional second server)

**Goal:** if the primary server, its internet or its whole site goes down, Bunkerr keeps serving from a second server somewhere else, for example a relative's house or a small VPS. It takes about 3 minutes plus Cloudflare's ~2-minute binding delay, and loses at most `SYNC_MINUTES` (default 15) of edits.

A single server needs none of this. Skip this page unless you want a standby.

## Requirements

- Two hosts running Bunkerr from this repo.
- A **private network** between them, so the standby can reach the primary's port and the primary can reach the standby's. A LAN, WireGuard or Tailscale all work.
- The public hostname on **Cloudflare**, with each host behind its own **Cloudflare Tunnel**. The watchdog switches the hostname's CNAME between the two tunnels.
- The same `INTERNAL_SECRET` on both hosts.

## How it works

- **Primary:** *active* unless it sees the standby has been promoted. In that case it fences itself: no notifications, and a banner in the UI.
- **Standby:** pulls a consistent SQLite snapshot from the primary every `SYNC_MINUTES` over the private network (`/api/internal/snapshot`, authenticated with `INTERNAL_SECRET` and refused through Cloudflare). It's *inactive* until promoted, so it never sends duplicate alerts.
- **Watchdog** (compose profile `standby`, container `bunkerr-watchdog`): checks the primary's `/healthz` every `CHECK_SECONDS` (30). After `FAIL_THRESHOLD` (6) failures in a row it:
  1. checks the public URL isn't still served by the primary. If it is, only the private link is broken, and it does nothing.
  2. checks the standby itself has internet,
  3. promotes the standby, then repoints the CNAME from `PRIMARY_TUNNEL_ID` to `STANDBY_TUNNEL_ID`.
- **Ops messages** (promoted, primary back, failed back) go to `OPS_NTFY_URL` and/or `OPS_DISCORD_WEBHOOK`, or a `WEBHOOK_ROUTER_URL` if you run one.
- **Failback is manual.** Edits made on the standby must be copied back first. The watchdog posts a message when the primary is reachable again.

Only one tunnel is in DNS at a time, so even with both hosts up, everyone uses the same database.

## Setup

**Primary `.env`:**
```
NODE_NAME=home
BUNKERR_ROLE=primary
PEER_URL=http://<standby private address>:8787
INTERNAL_SECRET=<same on both>
```

**Standby `.env`:**
```
NODE_NAME=offsite
BUNKERR_ROLE=standby
PEER_URL=http://<primary private address>:8787
INTERNAL_SECRET=<same on both>
BUNKERR_BIND=127.0.0.1:8787                    # for this host's cloudflared
BUNKERR_BIND_TAILNET=<standby private address>:8787
COMPOSE_PROFILES=standby
PUBLIC_HOST=bunkerr.example.com
CF_API_TOKEN=<Zone → DNS → Edit for the zone>
CF_ZONE_ID=<zone id>
PRIMARY_TUNNEL_ID=<primary's tunnel id>
STANDBY_TUNNEL_ID=<standby's tunnel id>
OPS_NTFY_URL=https://ntfy.sh/<random-ops-topic>   # and/or OPS_DISCORD_WEBHOOK=
```

Both tunnels need an ingress rule for `bunkerr.example.com`: the primary's points at the primary app (or its reverse proxy), the standby's at `http://localhost:8787`. Point the CNAME at the primary's tunnel (`<PRIMARY_TUNNEL_ID>.cfargotunnel.com`, proxied). Run `./deploy.sh` on the **primary first**, then on the standby.

⚠ After a CNAME flip, Cloudflare takes about 2 minutes to bind the new tunnel. During that window a 200 can still come from the *old* origin. Check which node answered with `curl https://bunkerr.example.com/healthz`, which reports `node`.

## Planned maintenance on the primary

On the standby:
```sh
docker compose run --rm watchdog /failover/promote.sh
```

## Failing back

When the primary is healthy again, at a quiet moment, on the standby:

```sh
docker compose run --rm watchdog /failover/failback.sh
```

The script waits until the primary sees it's fenced, then:
1. copies the standby database onto the primary,
2. repoints DNS to the primary's tunnel,
3. demotes the standby.

Edits made in the few seconds between the copy and the DNS switch are lost.

## Failover drill (do once after setup)

1. Add a test item. Wait for a standby sync: Settings → instance admin on the standby shows `last sync`.
2. Stop the primary: `docker compose stop bunkerr`.
3. Within about 5 minutes, `/healthz` reports the standby's `node`, and an ops message arrives.
4. Add an item on the standby.
5. `docker compose start bunkerr` on the primary. You get an ops message, and the site stays on the standby.
6. Run `failback.sh`. `/healthz` reports the primary, and the item from step 4 is present.

## Notes

- The standby's site only becomes part of the failure domain while it's promoted.
- The **RPO** (data you can lose) is up to `SYNC_MINUTES`. For near-zero loss, Litestream is the upgrade path.
- The watchdog's Cloudflare token needs only Zone → DNS → Edit on the one zone.
