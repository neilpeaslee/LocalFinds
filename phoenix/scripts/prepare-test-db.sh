#!/usr/bin/env bash
# Rebuild localfinds_test on the local :5434 stack from the canonical fixtures +
# migrations — the exact order db/tests/conftest.py and packages/db/test/harness.ts
# use. Seeds ONE custom place so the custom/% exclusion tests have a live target.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."   # repo root

DSN="postgres://localfinds:localfinds@localhost:5434"

psql -q "$DSN/postgres" -c "DROP DATABASE IF EXISTS localfinds_test"
psql -q "$DSN/postgres" -c "CREATE DATABASE localfinds_test"

for f in db/tests/fixtures/planet_osm.sql db/tests/fixtures/seed_osm.sql db/migrations/*.sql; do
  psql -q -v ON_ERROR_STOP=1 "$DSN/localfinds_test" -f "$f"
done

psql -q -v ON_ERROR_STOP=1 "$DSN/localfinds_test" <<'SQL'
INSERT INTO localfinds.custom_places
    (name, category, lat, lng, source_url, added_by)
VALUES
    ('Test Custom Cafe', 'amenity=cafe', 44.10, -69.11, 'https://example.test', 'test');
REFRESH MATERIALIZED VIEW public.osm_places;
SQL
