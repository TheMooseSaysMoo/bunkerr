#!/bin/sh
# Watchdog container entrypoint: install tools, then run the given script
# (default watchdog.sh). Manual use:
#   docker compose run --rm watchdog /failover/failback.sh
#   docker compose run --rm watchdog /failover/promote.sh
set -e
apk add --no-cache -q curl jq >/dev/null
exec /bin/sh "${1:-/failover/watchdog.sh}"
