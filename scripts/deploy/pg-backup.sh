#!/usr/bin/env bash
# Dump ONLY the localfinds schema (precious, non-rebuildable data) from the shared
# gis DB. OSM data (planet_osm_*, matviews) is intentionally NOT dumped — it rebuilds
# from Geofabrik. Runs ON THE BOX as the deploy user; the osm_api DSN is sourced from
# ~/localfinds-db.env (chmod 600, never a committed secret). Args: <prefix> <keep>.
set -euo pipefail
PREFIX="${1:-nightly}"
KEEP="${2:-14}"
: "${HOME:?}"
ENV_FILE="$HOME/localfinds-db.env"
DIR="$HOME/localfinds-backups"

[ -f "$ENV_FILE" ] || { echo "pg-backup: missing $ENV_FILE" >&2; exit 1; }
set -a; . "$ENV_FILE"; set +a
: "${LOCALFINDS_DATABASE_URL:?not set in $ENV_FILE}"

mkdir -p "$DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$DIR/${PREFIX}-${STAMP}.dump"
pg_dump -Fc --schema=localfinds -d "$LOCALFINDS_DATABASE_URL" > "$OUT"
echo "pg-backup: wrote $OUT ($(du -h "$OUT" | cut -f1))"

# Rotate: keep the newest $KEEP dumps of this prefix.
ls -1t "$DIR/${PREFIX}"-*.dump 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm --
echo "pg-backup: rotation done (prefix=$PREFIX keep=$KEEP)"
