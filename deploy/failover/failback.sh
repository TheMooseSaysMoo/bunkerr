#!/bin/sh
# Return service to the primary after a failover. Run on the standby, in the app dir:
#   docker compose run --rm watchdog /failover/failback.sh
# Steps: copy standby DB -> primary, point DNS at primary, demote standby.
# Do it at a quiet moment: edits made in the ~10 seconds between copy and DNS switch are lost.
. "$(dirname "$0")/lib.sh"

healthz "$PRIMARY_URL" >/dev/null || { log "primary not healthy at $PRIMARY_URL — aborting"; exit 1; }
[ "$(healthz "$STANDBY_URL" | jq -r .promoted)" = "true" ] || { log "standby is not promoted — nothing to fail back"; exit 1; }

# The primary only accepts a restore while fenced (it sees the standby active). It checks every 60s.
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  [ "$(healthz "$PRIMARY_URL" | jq -r .active)" = "false" ] && break
  log "waiting for primary to notice the active standby ($i)…"; sleep 10
done
[ "$(healthz "$PRIMARY_URL" | jq -r .active)" = "false" ] || { log "primary still thinks it is active (is PEER_URL set on the primary?) — aborting"; exit 1; }

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
log "downloading snapshot from standby"
internal "$STANDBY_URL" GET /api/internal/snapshot -o "$tmp"
log "snapshot $(wc -c <"$tmp") bytes; restoring onto primary"
internal "$PRIMARY_URL" POST /api/internal/restore -H 'content-type: application/octet-stream' --data-binary "@$tmp" >/dev/null

point_dns_to "$PRIMARY_TUNNEL_ID"
internal "$STANDBY_URL" POST /api/internal/demote >/dev/null
log "failback complete — primary serving, standby back to syncing"
ops_notify "failback complete — primary is serving again."
