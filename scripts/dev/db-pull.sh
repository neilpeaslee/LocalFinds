#!/usr/bin/env bash
# db:pull — extract a dev subset from LIVE (over the SSH tunnel) into a bundle
# under data/db/snapshots/<ts>/ (gitignored). Start the tunnel first:
#   bash scripts/db-tunnel.sh   (another shell)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

LIVE_DSN="${LIVE_DATABASE_URL:-postgresql://osm_api@localhost:5433/gis?sslmode=disable}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$ROOT/data/db/snapshots/$TS"
mkdir -p "$OUT"

echo "db:pull: from $LIVE_DSN -> $OUT"

# 1) app data (localfinds schema), custom format, data-only (incl. sequence values).
#    pg_dump via the pinned v15 image (host pg_dump is v14 and refuses a v15 server).
#    --network host reaches the tunnel at localhost:5433; ~/.pgpass is mounted for
#    osm_api auth; the output dir is mounted so --file lands on the host.
docker run --rm --network host \
  -v "$OUT:/out" \
  -v "$HOME/.pgpass:/root/.pgpass:ro" -e PGPASSFILE=/root/.pgpass \
  postgis/postgis:15-3.4 \
  pg_dump "$LIVE_DSN" --schema=localfinds --data-only --format=custom --file /out/localfinds-data.dump

# 2) osm_places OSM rows (exclude custom/, re-projected locally). Column order
#    MUST equal public.osm_places_snapshot (db/local/osm-places-local.sql).
psql "$LIVE_DSN" -v ON_ERROR_STOP=1 -c \
  "\copy (SELECT osm_id,name,kind,geom,point,tags,address,town,website,phone,brand FROM public.osm_places WHERE osm_id NOT LIKE 'custom/%') TO '$OUT/osm_places_snapshot.csv' WITH (FORMAT csv, HEADER true)"

# 3) region admin boundaries (admin_level 7/8) for local town resolution
psql "$LIVE_DSN" -v ON_ERROR_STOP=1 -c \
  "\copy (SELECT osm_id, tags, way FROM planet_osm_polygon WHERE tags->'boundary'='administrative' AND tags->'admin_level' IN ('7','8')) TO '$OUT/boundaries.csv' WITH (FORMAT csv, HEADER true)"

# 4) manifest with row counts
places=$(psql "$LIVE_DSN" -tAc "SELECT count(*) FROM public.osm_places WHERE osm_id NOT LIKE 'custom/%'")
bounds=$(psql "$LIVE_DSN" -tAc "SELECT count(*) FROM planet_osm_polygon WHERE tags->'boundary'='administrative' AND tags->'admin_level' IN ('7','8')")
printf '{"timestamp":"%s","osm_places_snapshot":%s,"boundaries":%s}\n' "$TS" "$places" "$bounds" > "$OUT/manifest.json"

# 5) update latest pointer
ln -sfn "$OUT" "$ROOT/data/db/snapshots/latest"
echo "db:pull: done ($places places, $bounds boundaries) -> $OUT"
