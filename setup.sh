#!/usr/bin/env bash
# First-time setup on a fresh server: .env, data folder, build, start, first admin account.
# Safe to re-run: an existing .env is kept, and the admin step can be skipped.
#
# Non-interactive: PUBLIC_URL=... TZ=... ADMIN_EMAIL=... ADMIN_NAME=... BUNKERR_PASSWORD=... ./setup.sh
set -euo pipefail
cd "$(dirname "$0")"

say()  { printf '\033[32m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[31mxx\033[0m %s\n' "$*" >&2; exit 1; }
ask()  { # ask VAR "question" default
  local var=$1 q=$2 def=${3:-} ans
  if [ -n "${!var:-}" ]; then return; fi
  if [ -t 0 ]; then read -rp "$q${def:+ [$def]}: " ans; else ans=""; fi
  printf -v "$var" '%s' "${ans:-$def}"
}

command -v docker >/dev/null || fail "Docker is required: https://docs.docker.com/engine/install/"
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required (the 'docker compose' command)"

# ---- .env ---------------------------------------------------------------------
if [ -f .env ]; then
  say ".env already exists, keeping it"
else
  say "creating .env"
  cp .env.example .env
  secret=$( (openssl rand -hex 32 2>/dev/null) || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
  ip=$(hostname -I 2>/dev/null | awk '{print $1}')
  ask PUBLIC_URL "Address people will open (https://bunkerr.example.com, or http://${ip:-192.168.1.10}:8787 to try it on your LAN)" "http://${ip:-localhost}:8787"
  tzdef=$( (timedatectl show -p Timezone --value 2>/dev/null) || cat /etc/timezone 2>/dev/null || echo America/New_York)
  ask TZ "Timezone" "$tzdef"
  sed -i -e "s|^INTERNAL_SECRET=.*|INTERNAL_SECRET=$secret|" -e "s|^PUBLIC_URL=.*|PUBLIC_URL=$PUBLIC_URL|" -e "s|^TZ=.*|TZ=$TZ|" .env
  say "wrote .env (INTERNAL_SECRET generated; keep a copy of .env somewhere safe)"
fi

# ---- data folder (the container runs as uid 1000) ------------------------------
mkdir -p data
if [ "$(stat -c %u data)" != "1000" ]; then
  say "giving data/ to uid 1000 (the app's user inside the container)"
  chown -R 1000:1000 data 2>/dev/null || sudo chown -R 1000:1000 data
fi

# ---- build + start ------------------------------------------------------------
say "building and starting (first build takes a few minutes)"
docker compose up -d --build

bind=${BUNKERR_BIND:-$(grep -E '^BUNKERR_BIND=' .env | cut -d= -f2)}
port=$(echo "${bind:-8787}" | awk -F: '{print $NF}')
say "waiting for the app on port $port"
for _ in $(seq 1 60); do
  if curl -fsS -m 3 "http://127.0.0.1:$port/healthz" >/dev/null 2>&1; then ok=1; break; fi
  sleep 2
done
[ "${ok:-}" = 1 ] || fail "the app didn't come up; check: docker compose logs bunkerr"

# ---- first admin ----------------------------------------------------------------
want=y
[ -t 0 ] && [ -z "${ADMIN_EMAIL:-}" ] && read -rp "Create the first admin account now? [Y/n]: " want
if [ "${want:-y}" != "n" ] && [ "${want:-y}" != "N" ]; then
  ask ADMIN_EMAIL "Admin email"
  ask ADMIN_NAME "Your name" "Admin"
  [ -n "${ADMIN_EMAIL:-}" ] || fail "an email is required"
  # The CLI asks for the password (or reads BUNKERR_PASSWORD).
  if [ -t 0 ] && [ -z "${BUNKERR_PASSWORD:-}" ]; then
    docker compose exec bunkerr node server/dist/cli.js create-admin "$ADMIN_EMAIL" "$ADMIN_NAME"
  else
    docker compose exec -T -e BUNKERR_PASSWORD="${BUNKERR_PASSWORD:?BUNKERR_PASSWORD is required without a terminal}" bunkerr node server/dist/cli.js create-admin "$ADMIN_EMAIL" "$ADMIN_NAME"
  fi
fi

url=$(grep -E '^PUBLIC_URL=' .env | cut -d= -f2-)
say "done. Open $url and log in."
say "next: put it behind HTTPS for phone installs and the camera (docs/03-deploy.md), and set up email in Settings."
