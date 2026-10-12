#!/bin/sh
# Runs next to the STANDBY. Promotes the standby when the primary is down.
# Never fails back automatically — writes made during failover would be lost. Use failback.sh.
. "$(dirname "$0")/lib.sh"

: "${CHECK_SECONDS:=30}"
: "${FAIL_THRESHOLD:=6}"   # 6 x 30s = 3 minutes of consecutive failures
: "${PRIMARY_NODE:=primary}"

fails=0
announced_back=0
log "watchdog: primary=$PRIMARY_URL standby=$STANDBY_URL threshold=${FAIL_THRESHOLD}x${CHECK_SECONDS}s"

while true; do
  promoted=$(healthz "$STANDBY_URL" 2>/dev/null | jq -r '.promoted // false' || echo false)

  if healthz "$PRIMARY_URL" >/dev/null 2>&1; then
    [ "$fails" -gt 0 ] && log "primary healthy again after $fails failed checks"
    fails=0
    if [ "$promoted" = "true" ] && [ "$announced_back" = "0" ]; then
      log "primary is back but standby is serving. Run failback.sh when convenient."
      ops_notify "primary ($PRIMARY_NODE) is reachable again. Standby is still serving — run failback.sh."
      announced_back=1
    fi
  else
    fails=$((fails + 1))
    log "primary check failed ($fails/$FAIL_THRESHOLD)"
    if [ "$fails" -ge "$FAIL_THRESHOLD" ] && [ "$promoted" != "true" ]; then
      # Partition guard 1: if the public URL still reaches the primary, only Tailscale is broken.
      pub_node=$(curl -fsS -m 8 "https://$PUBLIC_HOST/healthz" 2>/dev/null | jq -r '.node // empty' || true)
      if [ "$pub_node" = "$PRIMARY_NODE" ]; then
        log "primary unreachable over Tailscale but serving publicly — NOT promoting"
        ops_notify "Tailscale path to $PRIMARY_NODE is down but it's still serving publicly. Not failing over."
        fails=0
      # Partition guard 2: make sure *we* have internet.
      elif ! curl -fsS -m 8 -o /dev/null https://api.cloudflare.com/client/v4/ips; then
        log "standby has no internet — NOT promoting"
      else
        log "PROMOTING standby"
        if internal "$STANDBY_URL" POST /api/internal/promote >/dev/null && point_dns_to "$STANDBY_TUNNEL_ID"; then
          ops_notify "primary ($PRIMARY_NODE) down ${FAIL_THRESHOLD} checks — standby promoted and DNS switched."
          announced_back=0
        else
          log "promotion failed; will retry"
        fi
      fi
    fi
  fi
  sleep "$CHECK_SECONDS"
done
