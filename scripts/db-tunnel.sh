#!/usr/bin/env bash
# Open an SSH local port-forward from localhost:5433 to the prod Postgres
# (localhost:5432 on the server), so agents on the dev box can write to the
# single system of record WITHOUT exposing Postgres to the internet. Point
# LOCALFINDS_DATABASE_URL at postgresql://osm_api@localhost:5433/gis?sslmode=disable (password
# via ~/.pgpass) while this runs. Reuses DEPLOY_HOST from the gitignored data/config/deploy.env (the same
# infra config the deploy pipeline reads) so this committed script carries no
# host details. Ctrl-C to close.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="$ROOT/data/config/deploy.env"

if [ ! -f "$CONFIG" ]; then
  echo "db-tunnel: missing $CONFIG" >&2
  echo "db-tunnel: copy data/config/deploy.env.example to data/config/deploy.env and fill it in" >&2
  exit 1
fi
# shellcheck disable=SC1090
. "$CONFIG"
: "${DEPLOY_HOST:?set in deploy.env}"

LOCAL_PORT="${DB_TUNNEL_LOCAL_PORT:-5433}"
echo "db-tunnel: forwarding localhost:${LOCAL_PORT} -> ${DEPLOY_HOST}:localhost:5432 (Ctrl-C to close)"
exec ssh -N -L "${LOCAL_PORT}:localhost:5432" "$DEPLOY_HOST"
