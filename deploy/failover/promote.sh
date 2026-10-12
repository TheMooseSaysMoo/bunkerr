#!/bin/sh
# Manual failover (planned maintenance on the primary): promote standby + switch DNS now.
#   docker compose run --rm watchdog /failover/promote.sh
. "$(dirname "$0")/lib.sh"
internal "$STANDBY_URL" POST /api/internal/promote >/dev/null
point_dns_to "$STANDBY_TUNNEL_ID"
log "standby promoted manually"
ops_notify "standby promoted manually."
