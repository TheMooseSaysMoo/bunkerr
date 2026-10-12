#!/bin/sh
# Shared helpers for watchdog.sh / failback.sh. Requires: curl, jq.
# Config comes from the environment (the standby's .env; see .env.example and docs/04-failover.md).
set -eu

: "${PRIMARY_URL:=${PEER_URL:?PEER_URL or PRIMARY_URL (the primary over a private network, e.g. http://10.0.0.2:8787)}}"
: "${STANDBY_URL:=http://bunkerr:8787}"
: "${INTERNAL_SECRET:?INTERNAL_SECRET}"
: "${PUBLIC_HOST:?PUBLIC_HOST (the public hostname whose DNS record is switched, e.g. bunkerr.example.com)}"
: "${CF_API_TOKEN:?CF_API_TOKEN (Zone.DNS:Edit for the zone)}"
: "${CF_ZONE_ID:?CF_ZONE_ID}"
: "${PRIMARY_TUNNEL_ID:?PRIMARY_TUNNEL_ID}"
: "${STANDBY_TUNNEL_ID:?STANDBY_TUNNEL_ID}"
: "${OPS_DISCORD_WEBHOOK:=}"
: "${OPS_NTFY_URL:=}"     # full topic URL, e.g. https://ntfy.sh/my-bunkerr-ops
: "${OPS_NTFY_TOKEN:=}"
: "${WEBHOOK_ROUTER_URL:=}"

log() { echo "$(date -Iseconds) $*"; }

# Failover / failback notices. The webhook router goes first if there is one (if it lives next to
# the primary it's down in exactly the outage that triggers a failover); then ntfy and Discord.
ops_notify() {
  sent=0
  if [ -n "$WEBHOOK_ROUTER_URL" ]; then
    case "$WEBHOOK_ROUTER_URL" in */api/webhook/*) router_url=$WEBHOOK_ROUTER_URL ;; *) router_url="$WEBHOOK_ROUTER_URL/api/webhook/homelab_alert" ;; esac
    curl -fsS -m 6 -H 'content-type: application/json' \
      -d "$(jq -cn --arg b "$1" '{source:"bunkerr",title:"Bunkerr failover",body:$b,priority:"high"}')" \
      "$router_url" >/dev/null 2>&1 && return 0
  fi
  if [ -n "$OPS_NTFY_URL" ]; then
    if [ -n "$OPS_NTFY_TOKEN" ]; then auth="Authorization: Bearer $OPS_NTFY_TOKEN"; else auth="X-Bunkerr: 1"; fi
    curl -fsS -m 10 -H "Title: Bunkerr failover" -H "Priority: 4" -H "Tags: warning" -H "$auth" -d "$1" "$OPS_NTFY_URL" >/dev/null && sent=1 || log "ops ntfy failed"
  fi
  if [ -n "$OPS_DISCORD_WEBHOOK" ]; then
    curl -fsS -m 10 -H 'content-type: application/json' \
      -d "$(jq -cn --arg c "**Bunkerr failover:** $1" '{username:"Bunkerr ops",content:$c,allowed_mentions:{parse:[]}}')" \
      "$OPS_DISCORD_WEBHOOK" >/dev/null && sent=1 || log "ops discord failed"
  fi
  [ "$sent" = 1 ] || log "ops notify: no channel reachable or configured"
}

healthz() { curl -fsS -m 5 "$1/healthz"; }

internal() { # internal <base> <method> <path> [curl args...]
  base=$1; method=$2; path=$3; shift 3
  curl -fsS -m 120 -X "$method" -H "x-bunkerr-secret: $INTERNAL_SECRET" "$@" "$base$path"
}

cf() { # cf <method> <path> [json]
  if [ $# -ge 3 ]; then
    curl -fsS -m 20 -X "$1" -H "Authorization: Bearer $CF_API_TOKEN" -H 'content-type: application/json' -d "$3" "https://api.cloudflare.com/client/v4$2"
  else
    curl -fsS -m 20 -X "$1" -H "Authorization: Bearer $CF_API_TOKEN" "https://api.cloudflare.com/client/v4$2"
  fi
}

dns_record() { cf GET "/zones/$CF_ZONE_ID/dns_records?type=CNAME&name=$PUBLIC_HOST" | jq -r '.result[0] | "\(.id) \(.content)"'; }

point_dns_to() { # point_dns_to <tunnel-id>
  set -- "$1" $(dns_record)
  target="$1.cfargotunnel.com"; rec_id=$2; current=$3
  if [ "$current" = "$target" ]; then log "DNS already -> $target"; return 0; fi
  cf PATCH "/zones/$CF_ZONE_ID/dns_records/$rec_id" "$(jq -cn --arg c "$target" '{content:$c,proxied:true}')" >/dev/null
  log "DNS $PUBLIC_HOST -> $target"
}
