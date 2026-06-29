# osm-api

Self-hosted PostGIS-backed OSM query API for LocalFinds. Replaces the public
Overpass API as the cartographer's data source.

## Local development

    pip install -e ".[dev]"

Run the tests (requires Docker — pytest spins a throwaway PostGIS via
testcontainers):

    pytest

Run locally against the dev compose DB:

    docker compose up -d          # starts postgis on a local port
    # load schema + view + seed into it (see tests/conftest.py for the order),
    # then export DATABASE_URL + OSM_API_TOKEN and:
    uvicorn osm_api.main:app --reload

## Configuration (env vars)

- `DATABASE_URL` — asyncpg DSN for the `gis` database.
- `OSM_API_TOKEN` — shared bearer token required on every request.
- `DEFAULT_LIMIT` (default 200), `MAX_LIMIT` (default 1000).

## Production

Production values (port, nginx path, token, DB bind) live in the `udl` CM
workspace (`~/Projects/cm/udl`) and the gitignored deploy notes — never in this
repo. The PostGIS import, view application, and systemd/nginx setup are Track A
runbooks in that workspace.

## Schema bring-up (local or box)

Apply, in order, against the target `gis` DB:

1. (box only) the osm2pgsql import — `--create --slim --hstore-all`, classic output.
2. `sql/osm_businesses_view.sql` — creates `osm_businesses` as a **materialized
   view** (`WITH DATA`) plus its indexes. `town` is precomputed once per refresh
   instead of per query; see the file header for why. If `osm_businesses` already
   exists as a plain view, run `DROP VIEW IF EXISTS osm_businesses;` once first.
3. `sql/indexes.sql`

Because it is materialized, refresh it after every osm2pgsql-replication update
(daily cron): `REFRESH MATERIALIZED VIEW CONCURRENTLY osm_businesses;` (the
unique `osm_id` index makes CONCURRENTLY possible, so reads never block).

Locally, `tests/conftest.py` does the equivalent (fixture schema + matview + seed,
then `REFRESH MATERIALIZED VIEW osm_businesses`) inside a throwaway container, so
you only need this sequence for a persistent `docker compose` DB you want to hit
with `uvicorn`.
