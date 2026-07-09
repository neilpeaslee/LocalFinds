#!/usr/bin/env bash
# db:load — (re)build the LOCAL dev database (docker :5434) from a db:pull bundle.
# Idempotent: drops and rebuilds the schema each run. Usage:
#   npm run db:load [bundle-dir]   (default: data/db/snapshots/latest)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

LOCAL_DSN="${LOCALFINDS_LOCAL_DSN:-postgresql://localfinds:localfinds@localhost:5434/localfinds}"
BUNDLE="${1:-$ROOT/data/db/snapshots/latest}"

for f in localfinds-data.dump osm_places_snapshot.csv boundaries.csv; do
  if [ ! -f "$BUNDLE/$f" ]; then
    echo "db:load: missing $BUNDLE/$f (run: npm run db:pull)" >&2
    exit 1
  fi
done

# Resolve the `latest` symlink to a real dir so docker -v can bind-mount it.
BUNDLE="$(cd "$BUNDLE" && pwd -P)"

echo "db:load: rebuilding schema on $LOCAL_DSN"
psql "$LOCAL_DSN" -v ON_ERROR_STOP=1 <<'SQL'
DROP MATERIALIZED VIEW IF EXISTS public.osm_places CASCADE;
DROP TABLE IF EXISTS public.osm_places_snapshot CASCADE;
DROP TABLE IF EXISTS public.localfinds_boundaries CASCADE;
DROP SCHEMA IF EXISTS localfinds CASCADE;
SQL

psql "$LOCAL_DSN" -v ON_ERROR_STOP=1 -f "$ROOT/db/migrations/0001_localfinds_schema.sql"
psql "$LOCAL_DSN" -v ON_ERROR_STOP=1 -f "$ROOT/db/migrations/0004_run_events.sql"
psql "$LOCAL_DSN" -v ON_ERROR_STOP=1 -f "$ROOT/db/local/osm-places-local.sql"

echo "db:load: loading snapshot CSVs"
psql "$LOCAL_DSN" -v ON_ERROR_STOP=1 \
  -c "\copy public.osm_places_snapshot FROM '$BUNDLE/osm_places_snapshot.csv' WITH (FORMAT csv, HEADER true)"
psql "$LOCAL_DSN" -v ON_ERROR_STOP=1 \
  -c "\copy public.localfinds_boundaries FROM '$BUNDLE/boundaries.csv' WITH (FORMAT csv, HEADER true)"

echo "db:load: restoring localfinds app data"
# pg_restore via the pinned v15 image (host pg_restore is v14). --network host
# reaches the local DB at localhost:5434; the bundle is mounted read-only.
docker run --rm --network host -v "$BUNDLE:/bundle:ro" postgis/postgis:15-3.4 \
  pg_restore --data-only --disable-triggers --no-owner --dbname "$LOCAL_DSN" /bundle/localfinds-data.dump

psql "$LOCAL_DSN" -v ON_ERROR_STOP=1 -c "REFRESH MATERIALIZED VIEW public.osm_places;"
echo "db:load: done."
