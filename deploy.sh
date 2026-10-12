#!/usr/bin/env bash
# Pull the authoritative version from GitHub and rebuild.
# GitHub is the source of truth for this app.
#
# Safety:
#   * REFUSES to run if this host has uncommitted changes (FORCE=1 overrides).
#   * .env and data/ are gitignored, so reset --hard never touches them
#     -- untracked+ignored files always survive.
set -euo pipefail
cd "$(dirname "$0")"
BRANCH="${BRANCH:-main}"

DIRTY="$(git status --porcelain)"
if [ -n "$DIRTY" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "REFUSING TO DEPLOY -- uncommitted changes on this host would be destroyed:"
  echo "$DIRTY" | sed 's/^/    /'
  echo
  echo "Either capture this work first:"
  echo "    git add -A && git commit -m '...' && git push origin $BRANCH"
  echo "or discard it deliberately:"
  echo "    FORCE=1 $0"
  exit 1
fi

[ -f .env ] || { echo "missing .env (copy .env.example)"; exit 1; }

PREV="$(git rev-parse --short HEAD 2>/dev/null || echo none)"
git fetch origin "$BRANCH"
git reset --hard "origin/$BRANCH"
NEW="$(git rev-parse --short HEAD)"
echo "==> $PREV -> $NEW  (branch $BRANCH)"

# The container runs as uid 1000 (node); the bind-mounted data dir must be writable by it.
mkdir -p data
if [ "$(stat -c %u data)" != "1000" ]; then
  if [ "$(id -u)" = "0" ]; then chown 1000:1000 data; else sudo chown 1000:1000 data; fi
fi

docker compose up -d --build

PORT_CHECK="$(grep -E '^BUNKERR_BIND=' .env | cut -d= -f2- | sed -E 's/^.*://; s/^$/8787/')"
for i in $(seq 1 30); do
  if curl -fsS -m 3 "http://127.0.0.1:${PORT_CHECK:-8787}/healthz" >/dev/null 2>&1; then
    echo "==> healthy: $(curl -fsS -m 3 "http://127.0.0.1:${PORT_CHECK:-8787}/healthz")"
    break
  fi
  [ "$i" = 30 ] && { echo "!! not healthy after 60s -- docker compose logs bunkerr"; exit 1; }
  sleep 2
done
echo "==> rollback:  git reset --hard $PREV && docker compose up -d --build"
docker compose ps
