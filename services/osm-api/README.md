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
