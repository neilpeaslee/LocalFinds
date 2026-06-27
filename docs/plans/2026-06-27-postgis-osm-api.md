# PostGIS OSM-API (Tracks B + C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace LocalFinds' public-Overpass data source with a self-hosted PostGIS-backed HTTP API: build the `services/osm-api/` FastAPI service (Track B) and swap the cartographer's `overpass_query` tool for a thin `osm_query` client (Track C).

**Architecture:** A new standalone Python service (`services/osm-api/`) exposes `GET /osm/businesses` over a PostGIS `osm_businesses` view that projects imported OSM tables into the exact row shape the cartographer's `upsert_businesses` already accepts. The cartographer keeps its workspace, coverage cursor, and upsert path unchanged; only its query *tool* changes — `overpass.ts` is retired in favor of an HTTP client that calls the new API. The projection logic that lived client-side in `overpass.ts` moves server-side into the SQL view.

**Tech Stack:** Python 3.12, FastAPI, asyncpg, uvicorn (service); PostGIS 15 / `pg_trgm` / hstore (data); pytest + `testcontainers[postgres]` + httpx (Python tests); TypeScript + vitest (cartographer side).

## Global Constraints

- **Scope is Tracks B + C only.** Track A (infra: EBS resize → PostGIS install → Maine import → replication cron) is a **referenced prerequisite**, NOT part of this plan. Its supervised `sudo` runbooks live in `~/Projects/cm/udl` (Neil runs sudo; Claude is read-only). See "Track A — Prerequisite (referenced, not built here)" below.
- **This repo is public.** No EC2 IP, hostnames, ports, postgres credentials/bind, or auth tokens in git. All such values are env-var driven. `.env` is gitignored; only `.env.example` (placeholders) is committed.
- **Service is standalone**, not a TS monorepo workspace. It lives in `services/osm-api/` with its own `pyproject.toml`, `ruff`, and `pytest`. There is no existing Python/Docker/CI in the repo — this is greenfield Python tooling.
- **API row shape is the contract.** `GET /osm/businesses` returns a bare JSON array of objects with exactly these keys (the shape `upsert_businesses` accepts): `osm_id` (`"node/123"` / `"way/456"` / `"relation/789"`), `name`, `lat`, `lng`, `kind` (`"key=value"`), `tags` (array of lowercase strings), `address`, `town`, `website`, `phone`, `brand`.
- **Business keys** (the OSM keys that denote a business; first present becomes `kind`): `amenity`, `shop`, `tourism`, `office`, `craft`, `leisure`.
- **osm2pgsql import uses `--hstore-all`** (classic output + slim), not plain `--hstore`. Rationale: plain `--hstore` excludes tags promoted to their own columns, so the view could not read e.g. `name`/`amenity` from the hstore; `--hstore-all` puts *every* tag in the `tags` hstore, so the view reads everything from one column and is robust to `default.style`. This supersedes the spec's `--hstore`; the spec is updated to match in Task B2.
- **osm2pgsql geometry SRID is 3857** (web mercator). The view transforms to 4326 for `lat`/`lng` and keeps containment math in 3857.
- **osm2pgsql `osm_id` sign convention:** in `planet_osm_polygon`/`planet_osm_line`, a **negative** `osm_id` is a relation (use `relation/<abs>`), a **positive** one is a way (`way/<id>`). `planet_osm_point` ids are always nodes (`node/<id>`).
- **TS gate:** vitest does NOT typecheck. After any TS edit, run `cd packages/agents && npx tsc --noEmit`. There is no ESLint; tsc is the only static gate.
- **Python gate:** `ruff check .` and `pytest` from `services/osm-api/`.

---

## Track A — Prerequisite (referenced, not built here)

These steps run on the `udl` box as supervised `sudo` runbooks authored in `~/Projects/cm/udl` — **do not implement them in this repo.** They are listed only so the Track B/C work knows what production depends on:

1. **EBS resize 15 → 30 G** (`growpart` + `resize2fs`, online). **Hard first prereq** — root is 15 G @ ~77 %; an import on the shared volume risks filling root and downing every app on the box.
2. **Install** `postgresql-15-postgis-3`, `osm2pgsql`, `osm2pgsql-replication` into the existing shared PG15 cluster.
3. **Create the `gis` database + role** (isolated from co-tenant DBs); `CREATE EXTENSION postgis; CREATE EXTENSION hstore; CREATE EXTENSION pg_trgm;`.
4. **Import** `maine-latest.osm.pbf` with `osm2pgsql --create --slim --hstore-all --output=flex-or-pgsql` (classic pgsql output), throttled (`maintenance_work_mem`, parallelism capped) so it doesn't starve co-tenants. Run off-peak.
5. **Apply** `services/osm-api/sql/osm_businesses_view.sql` and `services/osm-api/sql/indexes.sql` to the `gis` DB (these files ARE built here, in Task B2).
6. **Fidelity check (one-time, during bring-up):** confirm the real `planet_osm_point` / `planet_osm_polygon` tables produced by osm2pgsql expose an `osm_id bigint`, a `tags hstore`, and a `way geometry(...,3857)` column (the only columns the view reads). The test fixture in Task B2 asserts the view against exactly this minimal schema; this check confirms the box matches it.
   - **Town-query benchmark (final-review finding I1):** the view computes `town` as a per-row correlated `ST_Contains` subquery, and the API filters town requests on that computed column — so a town query evaluates the subquery for every named business. Town is the cartographer's primary access pattern. `EXPLAIN ANALYZE` a real town query (e.g. `WHERE lower(town)=lower('Rockland')`) against the full Maine import and either **consciously accept** the latency (fine for the unattended low-QPS agent) or **optimize**: resolve the named admin polygon first, then `ST_Intersects`/`ST_Contains` businesses within it on the GiST-indexed raw `way` (optionally a materialized view + spatial index). This is a DB/import-side change, not an API-code change.
7. **Replication cron:** `osm2pgsql-replication` applies Geofabrik Maine diffs daily.
8. **Service deploy:** systemd unit running uvicorn bound to a loopback port, nginx-proxied with a token header. Concrete port / nginx path / token live in `cm/udl` + the gitignored deploy notes, never here.

---

## File Structure

**Track B — new files under `services/osm-api/`:**

- `pyproject.toml` — deps + ruff/pytest config (Python 3.12).
- `README.md` — local run + test instructions; points to `cm/udl` for prod values.
- `.gitignore` — `__pycache__/`, `.pytest_cache/`, `*.egg-info/`, `.venv/`.
- `docker-compose.yml` — a `postgis` service for local manual runs (tests use testcontainers, not this).
- `src/osm_api/__init__.py`
- `src/osm_api/config.py` — env-driven `Settings` (DATABASE_URL, OSM_API_TOKEN, default/max limit).
- `src/osm_api/db.py` — asyncpg pool lifecycle (`create_pool`, `close_pool`, `get_pool`).
- `src/osm_api/auth.py` — token-header FastAPI dependency.
- `src/osm_api/queries.py` — async `fetch_businesses(...)` over the view (town | bbox + keys + limit).
- `src/osm_api/models.py` — pydantic `Business` response model.
- `src/osm_api/main.py` — FastAPI app, `/osm/businesses`, `/health`, error handlers.
- `sql/osm_businesses_view.sql` — the projection view DDL.
- `sql/indexes.sql` — GIN(tags), trigram(name), GiST(way) index DDL (applied on the box in Track A).
- `sql/osm_fixture_schema.sql` — minimal `planet_osm_*` tables mirroring osm2pgsql `--hstore-all` output, for tests.
- `tests/conftest.py` — testcontainers PostGIS session fixture + schema/view/seed loader.
- `tests/seed.sql` — a handful of fixture rows (businesses + admin boundaries).
- `tests/test_view.py` — view projection correctness.
- `tests/test_queries.py` — query-layer filters.
- `tests/test_auth.py` — token dependency.
- `tests/test_endpoints.py` — endpoint status codes + shapes.

**Track C — changed files under `packages/agents/`:**

- Create: `packages/agents/src/osm-client.ts` — `runOsmQuery`, `formatOsmResult`, `isValidOsmId` (the surviving pure helper).
- Create: `packages/agents/src/osm-client.test.ts`.
- Modify: `packages/agents/src/mcp-tools.ts` — replace `overpass_query` tool with `osm_query`; switch `isValidOsmId` import.
- Modify: `packages/agents/src/agents/cartographer.ts` — `allowedTools` + system/task prompt.
- Modify: `packages/agents/src/mcp-tools.test.ts` — replace any `overpass_query` reference.
- Delete: `packages/agents/src/overpass.ts`, `packages/agents/src/overpass.test.ts`.
- Modify: `.env.example` — add `OSM_API_BASE`, `OSM_API_TOKEN` placeholders.

---

## Track B — the osm-api service

### Task B1: Service scaffold + config module

**Files:**
- Create: `services/osm-api/pyproject.toml`
- Create: `services/osm-api/.gitignore`
- Create: `services/osm-api/README.md`
- Create: `services/osm-api/src/osm_api/__init__.py`
- Create: `services/osm-api/src/osm_api/config.py`
- Test: `services/osm-api/tests/test_config.py`

**Interfaces:**
- Produces: `osm_api.config.Settings` (pydantic `BaseSettings`) with fields `database_url: str`, `osm_api_token: str`, `default_limit: int = 200`, `max_limit: int = 1000`; and `get_settings() -> Settings` (reads env, raises on missing required vars).

- [ ] **Step 1: Create `pyproject.toml`**

```toml
[project]
name = "osm-api"
version = "0.1.0"
description = "LocalFinds self-hosted PostGIS-backed OSM query API"
requires-python = ">=3.12"
dependencies = [
    "fastapi>=0.110",
    "uvicorn[standard]>=0.29",
    "asyncpg>=0.29",
    "pydantic>=2.6",
    "pydantic-settings>=2.2",
]

[project.optional-dependencies]
dev = [
    "pytest>=8.0",
    "pytest-asyncio>=0.23",
    "httpx>=0.27",
    "testcontainers[postgres]>=4.0",
    "ruff>=0.4",
]

[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[tool.setuptools.packages.find]
where = ["src"]

[tool.ruff]
line-length = 100
target-version = "py312"

[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]
```

- [ ] **Step 2: Create `.gitignore` and `__init__.py`**

`services/osm-api/.gitignore`:
```gitignore
__pycache__/
*.egg-info/
.pytest_cache/
.venv/
.ruff_cache/
```

`services/osm-api/src/osm_api/__init__.py`:
```python
"""LocalFinds self-hosted PostGIS-backed OSM query API."""
```

- [ ] **Step 3: Write the failing config test**

`services/osm-api/tests/test_config.py`:
```python
import pytest

from osm_api.config import Settings, get_settings


def test_settings_reads_required_env(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@localhost/gis")
    monkeypatch.setenv("OSM_API_TOKEN", "secret-token")
    s = get_settings()
    assert s.database_url == "postgresql://u:p@localhost/gis"
    assert s.osm_api_token == "secret-token"
    assert s.default_limit == 200
    assert s.max_limit == 1000


def test_settings_missing_required_env_raises(monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("OSM_API_TOKEN", raising=False)
    with pytest.raises(Exception):
        Settings()
```

- [ ] **Step 4: Run it to verify it fails**

Run: `cd services/osm-api && pip install -e ".[dev]" && pytest tests/test_config.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'osm_api.config'`.

- [ ] **Step 5: Implement `config.py`**

`services/osm-api/src/osm_api/config.py`:
```python
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Service configuration, entirely env-driven (no secrets in git)."""

    model_config = SettingsConfigDict(env_file=None, extra="ignore")

    database_url: str
    osm_api_token: str
    default_limit: int = 200
    max_limit: int = 1000


@lru_cache
def get_settings() -> Settings:
    return Settings()
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd services/osm-api && pytest tests/test_config.py -v`
Expected: PASS (2 passed).

- [ ] **Step 7: Write the README**

`services/osm-api/README.md`:
```markdown
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
```

- [ ] **Step 8: Verify ruff is clean and commit**

Run: `cd services/osm-api && ruff check .`
Expected: `All checks passed!`

```bash
git add services/osm-api/pyproject.toml services/osm-api/.gitignore services/osm-api/README.md services/osm-api/src/osm_api/__init__.py services/osm-api/src/osm_api/config.py services/osm-api/tests/test_config.py
git commit -m "feat(osm-api): scaffold service + env-driven config"
```

---

### Task B2: The `osm_businesses` view + test fixture schema

**Files:**
- Create: `services/osm-api/sql/osm_fixture_schema.sql`
- Create: `services/osm-api/sql/osm_businesses_view.sql`
- Create: `services/osm-api/sql/indexes.sql`
- Create: `services/osm-api/tests/seed.sql`
- Create: `services/osm-api/tests/conftest.py`
- Test: `services/osm-api/tests/test_view.py`
- Modify: `docs/superpowers/specs/2026-06-25-localfinds-postgis-osm-api-design.md` (the `--hstore` → `--hstore-all` line)

**Interfaces:**
- Produces: a SQL view `osm_businesses` with columns `osm_id text, name text, lat double precision, lng double precision, kind text, tags text[], address text, town text, website text, phone text, brand text`, and a representative-point geometry `geom geometry(Point, 3857)` used for spatial filtering. The view reads ONLY `osm_id`, `tags` (hstore), and `way` (geometry, 3857) from `planet_osm_point` and `planet_osm_polygon`.
- Produces: `services/osm-api/tests/conftest.py` fixtures `pg_dsn` (session-scoped DSN string) and `pg_conn` (function-scoped asyncpg connection).

- [ ] **Step 1: Create the fixture schema (mirrors osm2pgsql `--hstore-all` output, minimal)**

`services/osm-api/sql/osm_fixture_schema.sql`:
```sql
-- Minimal stand-in for the tables osm2pgsql produces with classic output +
-- --hstore-all. The view reads ONLY these three columns per table, so the
-- fixture only needs these three. (Track A's bring-up fidelity check confirms
-- the real osm2pgsql tables expose the same osm_id/tags/way columns.)
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS hstore;

CREATE TABLE planet_osm_point (
    osm_id bigint,
    tags   hstore,
    way    geometry(Point, 3857)
);

CREATE TABLE planet_osm_polygon (
    osm_id bigint,
    tags   hstore,
    way    geometry(Geometry, 3857)
);
```

- [ ] **Step 2: Create the view DDL**

`services/osm-api/sql/osm_businesses_view.sql`:
```sql
-- osm_businesses: projects imported OSM features into the exact row shape the
-- cartographer's upsert_businesses accepts. All business logic the cartographer
-- used to do client-side (kind, tag chips, address, town) lives here.
--
-- Reads only osm_id / tags (hstore) / way (geometry, 3857) — works against any
-- osm2pgsql import done with --hstore-all. Nodes come from planet_osm_point;
-- ways/relations (areas) from planet_osm_polygon. Geometry is web-mercator
-- (3857); lat/lng are transformed to 4326, containment math stays in 3857.
CREATE OR REPLACE VIEW osm_businesses AS
WITH src AS (
    -- nodes (way is already a point)
    SELECT
        'node/' || osm_id            AS osm_id,
        tags,
        way                          AS geom
    FROM planet_osm_point
    WHERE tags ? 'name'
      AND (tags ? 'amenity' OR tags ? 'shop' OR tags ? 'tourism'
           OR tags ? 'office' OR tags ? 'craft' OR tags ? 'leisure')
    UNION ALL
    -- ways / relations (areas). Negative osm_id in polygon = relation.
    SELECT
        CASE WHEN osm_id < 0
             THEN 'relation/' || (-osm_id)
             ELSE 'way/' || osm_id END AS osm_id,
        tags,
        ST_PointOnSurface(way)        AS geom
    FROM planet_osm_polygon
    WHERE tags ? 'name'
      AND (tags ? 'amenity' OR tags ? 'shop' OR tags ? 'tourism'
           OR tags ? 'office' OR tags ? 'craft' OR tags ? 'leisure')
)
SELECT
    s.osm_id,
    s.tags->'name'                                   AS name,
    ST_Y(ST_Transform(s.geom, 4326))                 AS lat,
    ST_X(ST_Transform(s.geom, 4326))                 AS lng,
    COALESCE(
        CASE WHEN s.tags ? 'amenity' THEN 'amenity=' || (s.tags->'amenity') END,
        CASE WHEN s.tags ? 'shop'    THEN 'shop='    || (s.tags->'shop')    END,
        CASE WHEN s.tags ? 'tourism' THEN 'tourism=' || (s.tags->'tourism') END,
        CASE WHEN s.tags ? 'office'  THEN 'office='  || (s.tags->'office')  END,
        CASE WHEN s.tags ? 'craft'   THEN 'craft='   || (s.tags->'craft')   END,
        CASE WHEN s.tags ? 'leisure' THEN 'leisure=' || (s.tags->'leisure') END
    )                                                AS kind,
    -- tag chips: business-key values + cuisine, split on ';', lowercased,
    -- distinct, capped at 12 — the server-side equivalent of the old tagList.
    COALESCE((
        SELECT array_agg(v)
        FROM (
            SELECT DISTINCT lower(trim(u)) AS v
            FROM unnest(string_to_array(
                concat_ws(';',
                    s.tags->'amenity', s.tags->'shop', s.tags->'tourism',
                    s.tags->'office',  s.tags->'craft', s.tags->'leisure',
                    s.tags->'cuisine'), ';')) AS u
            WHERE trim(u) <> ''
            LIMIT 12
        ) chips
    ), ARRAY[]::text[])                              AS tags,  -- never NULL
    NULLIF(trim(concat_ws(', ',
        NULLIF(trim(concat_ws(' ',
            s.tags->'addr:housenumber', s.tags->'addr:street')), ''),
        s.tags->'addr:city')), '')                   AS address,
    (
        SELECT b.tags->'name'
        FROM planet_osm_polygon b
        WHERE b.tags->'boundary' = 'administrative'
          AND b.tags->'admin_level' IN ('7', '8')
          AND ST_Contains(b.way, s.geom)
        ORDER BY b.tags->'admin_level' DESC   -- prefer level 8 (town) over 7
        LIMIT 1
    )                                                AS town,
    COALESCE(s.tags->'website', s.tags->'contact:website') AS website,
    COALESCE(s.tags->'phone',   s.tags->'contact:phone')   AS phone,
    s.tags->'brand'                                  AS brand,
    s.geom                                           AS geom
FROM src s;
```

- [ ] **Step 3: Create the production index DDL (applied on the box in Track A)**

`services/osm-api/sql/indexes.sql`:
```sql
-- Applied to the gis DB during Track A import bring-up. Not needed for tests
-- (the fixture is tiny), but kept here so the index strategy is versioned.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- GIN over the hstore tags (the view's key existence + value lookups).
CREATE INDEX IF NOT EXISTS planet_osm_point_tags_gin
    ON planet_osm_point USING gin (tags);
CREATE INDEX IF NOT EXISTS planet_osm_polygon_tags_gin
    ON planet_osm_polygon USING gin (tags);

-- Trigram on name (seeds the future /osm/search FTS endpoint).
CREATE INDEX IF NOT EXISTS planet_osm_point_name_trgm
    ON planet_osm_point USING gin ((tags->'name') gin_trgm_ops);
CREATE INDEX IF NOT EXISTS planet_osm_polygon_name_trgm
    ON planet_osm_polygon USING gin ((tags->'name') gin_trgm_ops);

-- osm2pgsql already creates a GiST index on `way`; nothing to add here.
```

- [ ] **Step 4: Create seed rows**

`services/osm-api/tests/seed.sql`:
```sql
-- Two admin boundaries (an admin_level 8 "Rockland" town polygon, and an
-- overlapping level 7 "Knox County") + business features inside/outside.
-- Geometry is 3857 (web mercator). Rockland, ME is ~ -69.11, 44.10. hstore
-- values are built with hstore(text[], text[]) so spaces/colons/slashes in
-- values (e.g. "Rock City Coffee", "https://...") need no manual quoting.

-- admin_level 8 town: a square around Rockland
INSERT INTO planet_osm_polygon (osm_id, tags, way) VALUES
(-100,
 hstore(ARRAY['boundary','admin_level','name'],
        ARRAY['administrative','8','Rockland']),
 ST_Transform(ST_MakeEnvelope(-69.20, 44.05, -69.05, 44.15, 4326), 3857));

-- admin_level 7 county: a larger square enclosing the town
INSERT INTO planet_osm_polygon (osm_id, tags, way) VALUES
(-101,
 hstore(ARRAY['boundary','admin_level','name'],
        ARRAY['administrative','7','Knox County']),
 ST_Transform(ST_MakeEnvelope(-69.40, 43.90, -68.90, 44.30, 4326), 3857));

-- A node café inside Rockland, with cuisine + contact tags + a chain brand
INSERT INTO planet_osm_point (osm_id, tags, way) VALUES
(1,
 hstore(
   ARRAY['amenity','name','cuisine','website','phone',
         'addr:housenumber','addr:street','addr:city','brand'],
   ARRAY['cafe','Rock City Coffee','coffee_shop;cafe','https://rockcity.example',
         '+1-207-555-0100','316','Main Street','Rockland','Rock City']),
 ST_Transform(ST_SetSRID(ST_MakePoint(-69.11, 44.10), 4326), 3857));

-- A way (positive id) shop polygon inside Rockland
INSERT INTO planet_osm_polygon (osm_id, tags, way) VALUES
(2,
 hstore(ARRAY['shop','name'], ARRAY['supermarket','Hannaford']),
 ST_Transform(ST_MakeEnvelope(-69.115, 44.095, -69.112, 44.098, 4326), 3857));

-- A relation (negative id) museum polygon inside Rockland
INSERT INTO planet_osm_polygon (osm_id, tags, way) VALUES
(-3,
 hstore(ARRAY['tourism','name'], ARRAY['museum','Farnsworth Art Museum']),
 ST_Transform(ST_MakeEnvelope(-69.108, 44.103, -69.106, 44.105, 4326), 3857));

-- An unnamed node (must be excluded by the view)
INSERT INTO planet_osm_point (osm_id, tags, way) VALUES
(4,
 hstore(ARRAY['amenity'], ARRAY['bench']),
 ST_Transform(ST_SetSRID(ST_MakePoint(-69.11, 44.10), 4326), 3857));

-- A named node with NO business key (must be excluded by the view)
INSERT INTO planet_osm_point (osm_id, tags, way) VALUES
(5,
 hstore(ARRAY['name','highway'], ARRAY['Some Street','residential']),
 ST_Transform(ST_SetSRID(ST_MakePoint(-69.11, 44.10), 4326), 3857));
```

- [ ] **Step 5: Create the testcontainers conftest**

`services/osm-api/tests/conftest.py`:
```python
from pathlib import Path

import asyncpg
import pytest
import pytest_asyncio
from testcontainers.postgres import PostgresContainer

SQL_DIR = Path(__file__).resolve().parents[1] / "sql"
SEED = Path(__file__).resolve().parent / "seed.sql"


def _to_asyncpg_dsn(url: str) -> str:
    # testcontainers yields a SQLAlchemy-style URL; asyncpg wants postgresql://
    return url.replace("postgresql+psycopg2://", "postgresql://")


@pytest.fixture(scope="session")
def pg_dsn():
    with PostgresContainer("postgis/postgis:15-3.4") as pg:
        dsn = _to_asyncpg_dsn(pg.get_connection_url())
        _load_schema(dsn)
        yield dsn


def _load_schema(dsn: str):
    import asyncio

    async def run():
        conn = await asyncpg.connect(dsn)
        try:
            for f in (
                SQL_DIR / "osm_fixture_schema.sql",
                SQL_DIR / "osm_businesses_view.sql",
                SEED,
            ):
                await conn.execute(f.read_text())
        finally:
            await conn.close()

    asyncio.run(run())


@pytest_asyncio.fixture
async def pg_conn(pg_dsn):
    conn = await asyncpg.connect(pg_dsn)
    try:
        yield conn
    finally:
        await conn.close()
```

- [ ] **Step 6: Write the failing view test**

`services/osm-api/tests/test_view.py`:
```python
async def _rows(pg_conn):
    return await pg_conn.fetch("SELECT * FROM osm_businesses ORDER BY osm_id")


async def test_view_excludes_unnamed_and_non_business(pg_conn):
    ids = {r["osm_id"] for r in await _rows(pg_conn)}
    # exactly the three business features; the bench (4) and street (5) are gone,
    # and the relation's negative polygon id -3 renders as "relation/3"
    assert ids == {"node/1", "way/2", "relation/3"}


async def test_view_osm_id_forms(pg_conn):
    rows = {r["osm_id"]: r for r in await _rows(pg_conn)}
    assert "node/1" in rows         # point -> node
    assert "way/2" in rows          # positive polygon id -> way
    assert "relation/3" in rows     # negative polygon id -> relation/<abs>


async def test_view_projects_cafe_fields(pg_conn):
    rows = {r["osm_id"]: r for r in await _rows(pg_conn)}
    cafe = rows["node/1"]
    assert cafe["name"] == "Rock City Coffee"
    assert cafe["kind"] == "amenity=cafe"
    assert abs(cafe["lat"] - 44.10) < 0.001
    assert abs(cafe["lng"] - (-69.11)) < 0.001
    assert cafe["website"] == "https://rockcity.example"
    assert cafe["phone"] == "+1-207-555-0100"
    assert cafe["brand"] == "Rock City"
    assert cafe["address"] == "316 Main Street, Rockland"
    assert cafe["town"] == "Rockland"            # level-8 wins over level-7
    assert set(cafe["tags"]) == {"cafe", "coffee_shop"}  # cuisine split + key value


async def test_view_kind_first_business_key(pg_conn):
    rows = {r["osm_id"]: r for r in await _rows(pg_conn)}
    assert rows["way/2"]["kind"] == "shop=supermarket"
    assert rows["relation/3"]["kind"] == "tourism=museum"
```

- [ ] **Step 7: Run the view tests to verify they fail (then pass)**

Run: `cd services/osm-api && pytest tests/test_view.py -v`
Expected: first run FAILS if any SQL is wrong (iterate on `osm_businesses_view.sql` / `seed.sql` until green). Target: PASS (4 passed). The `node/1` `tags` assertion confirms cuisine `"coffee_shop;cafe"` splits and the `amenity=cafe` value `"cafe"` dedupes to `{"cafe", "coffee_shop"}`.

- [ ] **Step 8: Update the spec's hstore line**

In `docs/superpowers/specs/2026-06-25-localfinds-postgis-osm-api-design.md`, change the Data section bullet from `--hstore` to `--hstore-all` and add the one-line rationale. Find:
```
- osm2pgsql in **classic output + `--hstore` + slim** loads
```
Replace with:
```
- osm2pgsql in **classic output + `--hstore-all` + slim** loads
```
And in the same bullet, change `all tags preserved in an hstore column` to `all tags preserved in an hstore column (`--hstore-all`, so even column-promoted tags like name/amenity stay in the hstore the view reads)`.

- [ ] **Step 9: Verify ruff clean and commit**

Run: `cd services/osm-api && ruff check .`
Expected: `All checks passed!`

```bash
git add services/osm-api/sql/ services/osm-api/tests/conftest.py services/osm-api/tests/seed.sql services/osm-api/tests/test_view.py docs/superpowers/specs/2026-06-25-localfinds-postgis-osm-api-design.md
git commit -m "feat(osm-api): osm_businesses view + test fixtures; spec --hstore-all"
```

---

### Task B3: Query layer

**Files:**
- Create: `services/osm-api/src/osm_api/queries.py`
- Test: `services/osm-api/tests/test_queries.py`

**Interfaces:**
- Consumes: the `osm_businesses` view (Task B2); `BUSINESS_KEYS` constant.
- Produces:
  - `BUSINESS_KEYS: tuple[str, ...]` = `("amenity", "shop", "tourism", "office", "craft", "leisure")`.
  - `class BboxError(ValueError)` — raised on a malformed bbox.
  - `parse_bbox(raw: str) -> tuple[float, float, float, float]` — parses `"s,w,n,e"`, validates ranges and `s<n`, `w<e`; raises `BboxError`.
  - `async fetch_businesses(conn, *, town: str | None, bbox: tuple[float,float,float,float] | None, keys: list[str] | None, limit: int) -> list[dict]` — returns view rows (as dicts) filtered by town (exact, case-insensitive) OR bbox, optionally narrowed to `keys`, capped at `limit`. Exactly one of `town`/`bbox` must be set (caller enforces). Raises `ValueError` if `keys` is non-empty and contains any value not in `BUSINESS_KEYS` (the B5 endpoint maps this to a 400) — never silently drops unknown keys.

- [ ] **Step 1: Write the failing query tests**

`services/osm-api/tests/test_queries.py`:
```python
import pytest

from osm_api.queries import BboxError, fetch_businesses, parse_bbox


def test_parse_bbox_ok():
    assert parse_bbox("44.05,-69.20,44.15,-69.05") == (44.05, -69.20, 44.15, -69.05)


@pytest.mark.parametrize("raw", ["1,2,3", "a,b,c,d", "44.2,-69,44.1,-68", "91,0,92,1"])
def test_parse_bbox_rejects_bad(raw):
    with pytest.raises(BboxError):
        parse_bbox(raw)


async def test_fetch_by_town(pg_conn):
    rows = await fetch_businesses(
        pg_conn, town="rockland", bbox=None, keys=None, limit=100
    )
    ids = {r["osm_id"] for r in rows}
    assert ids == {"node/1", "way/2", "relation/3"}


async def test_fetch_by_town_unknown_is_empty(pg_conn):
    rows = await fetch_businesses(
        pg_conn, town="nowhere", bbox=None, keys=None, limit=100
    )
    assert rows == []


async def test_fetch_keys_filter(pg_conn):
    rows = await fetch_businesses(
        pg_conn, town="rockland", bbox=None, keys=["shop"], limit=100
    )
    assert {r["osm_id"] for r in rows} == {"way/2"}


async def test_fetch_by_bbox(pg_conn):
    rows = await fetch_businesses(
        pg_conn, town=None, bbox=(44.05, -69.20, 44.15, -69.05), keys=None, limit=100
    )
    assert {r["osm_id"] for r in rows} == {"node/1", "way/2", "relation/3"}


async def test_fetch_limit_caps(pg_conn):
    rows = await fetch_businesses(
        pg_conn, town="rockland", bbox=None, keys=None, limit=1
    )
    assert len(rows) == 1
```

- [ ] **Step 2: Run to verify failure**

Run: `cd services/osm-api && pytest tests/test_queries.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'osm_api.queries'`.

- [ ] **Step 3: Implement `queries.py`**

`services/osm-api/src/osm_api/queries.py`:
```python
from __future__ import annotations

import asyncpg

BUSINESS_KEYS: tuple[str, ...] = (
    "amenity", "shop", "tourism", "office", "craft", "leisure",
)


class BboxError(ValueError):
    """Raised when a bbox string is malformed or out of range."""


def parse_bbox(raw: str) -> tuple[float, float, float, float]:
    parts = raw.split(",")
    if len(parts) != 4:
        raise BboxError("bbox must be 's,w,n,e' (four comma-separated numbers)")
    try:
        s, w, n, e = (float(p) for p in parts)
    except ValueError as exc:
        raise BboxError("bbox values must be numbers") from exc
    if not (-90 <= s <= 90 and -90 <= n <= 90):
        raise BboxError("bbox lat (s, n) must be within [-90, 90]")
    if not (-180 <= w <= 180 and -180 <= e <= 180):
        raise BboxError("bbox lng (w, e) must be within [-180, 180]")
    if s >= n or w >= e:
        raise BboxError("bbox must have s < n and w < e")
    return (s, w, n, e)


async def fetch_businesses(
    conn: asyncpg.Connection,
    *,
    town: str | None,
    bbox: tuple[float, float, float, float] | None,
    keys: list[str] | None,
    limit: int,
) -> list[dict]:
    where: list[str] = []
    params: list[object] = []

    if town is not None:
        params.append(town)
        where.append(f"lower(town) = lower(${len(params)})")
    elif bbox is not None:
        s, w, n, e = bbox
        # geom is 3857; build the filter envelope in 4326 and transform.
        params.extend([w, s, e, n])
        where.append(
            f"ST_Intersects(geom, ST_Transform("
            f"ST_MakeEnvelope(${len(params)-3}, ${len(params)-2}, "
            f"${len(params)-1}, ${len(params)}, 4326), 3857))"
        )
    else:  # pragma: no cover - caller guarantees exactly one
        raise ValueError("exactly one of town/bbox is required")

    if keys:
        # Validate against the allowlist and reject unknown keys outright — a
        # silent drop would turn keys=["badkey"] into "return everything".
        invalid = [k for k in keys if k not in BUSINESS_KEYS]
        if invalid:
            raise ValueError(f"unknown business key(s): {', '.join(invalid)}")
        ors = " OR ".join(f"kind LIKE '{k}=%'" for k in keys)
        where.append(f"({ors})")

    params.append(limit)
    sql = (
        "SELECT osm_id, name, lat, lng, kind, tags, address, town, "
        "website, phone, brand FROM osm_businesses WHERE "
        + " AND ".join(where)
        + f" LIMIT ${len(params)}"
    )
    rows = await conn.fetch(sql, *params)
    return [dict(r) for r in rows]
```

Note: `keys` are validated against the `BUSINESS_KEYS` allowlist before being
interpolated into the `LIKE` clause, so no untrusted text reaches the SQL string;
all other values are passed as bound parameters.

- [ ] **Step 4: Run to verify pass**

Run: `cd services/osm-api && pytest tests/test_queries.py -v`
Expected: PASS (all parametrized + DB cases green).

- [ ] **Step 5: Commit**

```bash
git add services/osm-api/src/osm_api/queries.py services/osm-api/tests/test_queries.py
git commit -m "feat(osm-api): query layer (town/bbox/keys/limit) over osm_businesses"
```

---

### Task B4: DB pool + auth dependency

**Files:**
- Create: `services/osm-api/src/osm_api/db.py`
- Create: `services/osm-api/src/osm_api/auth.py`
- Test: `services/osm-api/tests/test_auth.py`

**Interfaces:**
- Produces (`db.py`): `async create_pool(dsn: str) -> asyncpg.Pool`, `async close_pool(pool) -> None`, and an app-state accessor `get_pool(request) -> asyncpg.Pool` (reads `request.app.state.pool`, raises `RuntimeError` if absent).
- Produces (`auth.py`): `require_token(authorization: str | None = Header(None)) -> None` — a stateless FastAPI dependency (no `request` needed) that raises `HTTPException(401)` unless the `Authorization: Bearer <token>` header matches `get_settings().osm_api_token`.

- [ ] **Step 1: Implement `db.py`**

`services/osm-api/src/osm_api/db.py`:
```python
from __future__ import annotations

import asyncpg
from fastapi import Request


async def create_pool(dsn: str) -> asyncpg.Pool:
    return await asyncpg.create_pool(dsn, min_size=1, max_size=10)


async def close_pool(pool: asyncpg.Pool) -> None:
    await pool.close()


def get_pool(request: Request) -> asyncpg.Pool:
    pool = getattr(request.app.state, "pool", None)
    if pool is None:
        raise RuntimeError("db pool not initialized")
    return pool
```

- [ ] **Step 2: Write the failing auth test**

`services/osm-api/tests/test_auth.py`:
```python
import pytest
from fastapi import HTTPException

from osm_api.auth import require_token
from osm_api.config import get_settings


@pytest.fixture(autouse=True)
def _token_env(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@localhost/gis")
    monkeypatch.setenv("OSM_API_TOKEN", "secret-token")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def test_require_token_accepts_matching_bearer():
    require_token(authorization="Bearer secret-token")  # no raise


@pytest.mark.parametrize("header", [None, "secret-token", "Bearer wrong", "Basic x"])
def test_require_token_rejects(header):
    with pytest.raises(HTTPException) as exc:
        require_token(authorization=header)
    assert exc.value.status_code == 401
```

- [ ] **Step 3: Run to verify failure**

Run: `cd services/osm-api && pytest tests/test_auth.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'osm_api.auth'`.

- [ ] **Step 4: Implement `auth.py`**

`services/osm-api/src/osm_api/auth.py`:
```python
from __future__ import annotations

import secrets

from fastapi import Header, HTTPException

from .config import get_settings


def require_token(authorization: str | None = Header(default=None)) -> None:
    expected = get_settings().osm_api_token
    prefix = "Bearer "
    if not authorization or not authorization.startswith(prefix):
        raise HTTPException(status_code=401, detail="missing bearer token")
    supplied = authorization[len(prefix):]
    if not secrets.compare_digest(supplied, expected):
        raise HTTPException(status_code=401, detail="invalid token")
```

- [ ] **Step 5: Run to verify pass**

Run: `cd services/osm-api && pytest tests/test_auth.py -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add services/osm-api/src/osm_api/db.py services/osm-api/src/osm_api/auth.py services/osm-api/tests/test_auth.py
git commit -m "feat(osm-api): asyncpg pool lifecycle + bearer-token dependency"
```

---

### Task B5: FastAPI app + endpoints

**Files:**
- Create: `services/osm-api/src/osm_api/models.py`
- Create: `services/osm-api/src/osm_api/main.py`
- Test: `services/osm-api/tests/test_endpoints.py`

**Interfaces:**
- Consumes: `config.get_settings`, `db.create_pool/close_pool/get_pool`, `auth.require_token`, `queries.fetch_businesses/parse_bbox/BboxError`.
- Produces: `osm_api.main.app` (FastAPI). Endpoints:
  - `GET /health` → `{"status": "ok"}` (no auth).
  - `GET /osm/businesses?town=&bbox=&keys=&limit=` (auth required) → bare JSON array of `Business` objects. 400 on bad params (neither/both of town/bbox, bad bbox, bad limit); 401 via dependency; 503 if the DB is unreachable. Unknown town → `[]`.
- Produces (`models.py`): pydantic `Business` model matching the contract row shape.

- [ ] **Step 1: Implement `models.py`**

`services/osm-api/src/osm_api/models.py`:
```python
from __future__ import annotations

from pydantic import BaseModel


class Business(BaseModel):
    osm_id: str
    name: str | None
    lat: float | None
    lng: float | None
    kind: str | None
    tags: list[str] = []
    address: str | None
    town: str | None
    website: str | None
    phone: str | None
    brand: str | None
```

- [ ] **Step 2: Write the failing endpoint tests**

`services/osm-api/tests/test_endpoints.py`:
```python
import asyncpg
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from osm_api.config import get_settings
from osm_api.main import app

AUTH = {"Authorization": "Bearer secret-token"}


@pytest.fixture(autouse=True)
def _env(monkeypatch, pg_dsn):
    monkeypatch.setenv("DATABASE_URL", pg_dsn)
    monkeypatch.setenv("OSM_API_TOKEN", "secret-token")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest_asyncio.fixture
async def client(pg_dsn):
    app.state.pool = await asyncpg.create_pool(pg_dsn, min_size=1, max_size=4)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
    await app.state.pool.close()
    app.state.pool = None


async def test_health_no_auth(client):
    r = await client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


async def test_businesses_requires_token(client):
    r = await client.get("/osm/businesses?town=rockland")
    assert r.status_code == 401


async def test_businesses_by_town_returns_array(client):
    r = await client.get("/osm/businesses?town=rockland", headers=AUTH)
    assert r.status_code == 200
    body = r.json()
    assert isinstance(body, list)
    assert {b["osm_id"] for b in body} == {"node/1", "way/2", "relation/3"}
    # row shape matches the upsert contract
    cafe = next(b for b in body if b["osm_id"] == "node/1")
    assert set(cafe) == {
        "osm_id", "name", "lat", "lng", "kind", "tags",
        "address", "town", "website", "phone", "brand",
    }


async def test_businesses_unknown_town_empty(client):
    r = await client.get("/osm/businesses?town=nowhere", headers=AUTH)
    assert r.status_code == 200
    assert r.json() == []


async def test_businesses_bad_bbox_400(client):
    r = await client.get("/osm/businesses?bbox=1,2,3", headers=AUTH)
    assert r.status_code == 400


async def test_businesses_unknown_key_400(client):
    r = await client.get("/osm/businesses?town=rockland&keys=badkey", headers=AUTH)
    assert r.status_code == 400


async def test_businesses_bad_limit_400(client):
    r = await client.get("/osm/businesses?town=rockland&limit=0", headers=AUTH)
    assert r.status_code == 400


async def test_businesses_requires_exactly_one_filter(client):
    assert (await client.get("/osm/businesses", headers=AUTH)).status_code == 400
    assert (
        await client.get(
            "/osm/businesses?town=x&bbox=44,-70,45,-69", headers=AUTH
        )
    ).status_code == 400


async def test_businesses_db_down_503(client, monkeypatch):
    async def boom(*a, **k):
        raise asyncpg.PostgresError("db gone")

    monkeypatch.setattr("osm_api.main.fetch_businesses", boom)
    r = await client.get("/osm/businesses?town=rockland", headers=AUTH)
    assert r.status_code == 503
```

- [ ] **Step 3: Run to verify failure**

Run: `cd services/osm-api && pytest tests/test_endpoints.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'osm_api.main'`.

- [ ] **Step 4: Implement `main.py`**

`services/osm-api/src/osm_api/main.py`:
```python
from __future__ import annotations

from contextlib import asynccontextmanager

import asyncpg
from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse

from .auth import require_token
from .config import get_settings
from .db import close_pool, create_pool, get_pool
from .models import Business
from .queries import BboxError, fetch_businesses, parse_bbox


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Skip if a test already injected a pool.
    own_pool = getattr(app.state, "pool", None) is None
    if own_pool:
        app.state.pool = await create_pool(get_settings().database_url)
    try:
        yield
    finally:
        if own_pool and getattr(app.state, "pool", None) is not None:
            await close_pool(app.state.pool)
            app.state.pool = None


app = FastAPI(title="LocalFinds osm-api", lifespan=lifespan)


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}


@app.get("/osm/businesses", dependencies=[Depends(require_token)])
async def businesses(
    request: Request,
    town: str | None = Query(default=None),
    bbox: str | None = Query(default=None, description="'s,w,n,e' (WGS84)"),
    keys: str | None = Query(default=None, description="csv of business keys"),
    limit: int | None = Query(default=None),
) -> list[Business]:
    if (town is None) == (bbox is None):
        raise HTTPException(400, "provide exactly one of 'town' or 'bbox'")
    if limit is not None and limit < 1:
        raise HTTPException(400, "limit must be >= 1")

    parsed_bbox = None
    if bbox is not None:
        try:
            parsed_bbox = parse_bbox(bbox)
        except BboxError as exc:
            raise HTTPException(400, str(exc)) from exc

    settings = get_settings()
    effective = min(limit or settings.default_limit, settings.max_limit)
    key_list = [k.strip() for k in keys.split(",") if k.strip()] if keys else None

    pool = get_pool(request)
    try:
        async with pool.acquire() as conn:
            rows = await fetch_businesses(
                conn, town=town, bbox=parsed_bbox, keys=key_list, limit=effective
            )
    except ValueError as exc:
        # bad input surfaced by the query layer (e.g. an unknown business key)
        raise HTTPException(400, str(exc)) from exc
    except (asyncpg.PostgresError, OSError) as exc:
        raise HTTPException(503, "database unavailable") from exc

    return [Business(**r) for r in rows]


@app.exception_handler(RuntimeError)
async def _runtime_error(_request: Request, exc: RuntimeError):
    # e.g. pool not initialized
    return JSONResponse(status_code=503, content={"detail": str(exc)})
```

- [ ] **Step 5: Run to verify pass**

Run: `cd services/osm-api && pytest tests/test_endpoints.py -v`
Expected: PASS. (The `503` test patches `osm_api.main.fetch_businesses` to raise `asyncpg.PostgresError`.)

- [ ] **Step 6: Run the full Python suite + ruff**

Run: `cd services/osm-api && ruff check . && pytest -v`
Expected: ruff clean; all tests pass (config, view, queries, auth, endpoints).

- [ ] **Step 7: Commit**

```bash
git add services/osm-api/src/osm_api/models.py services/osm-api/src/osm_api/main.py services/osm-api/tests/test_endpoints.py
git commit -m "feat(osm-api): FastAPI app, /osm/businesses + /health, error handling"
```

---

### Task B6: Local-dev compose + bring-up docs

**Files:**
- Create: `services/osm-api/docker-compose.yml`
- Modify: `services/osm-api/README.md` (add the bring-up cross-reference)

**Interfaces:**
- Produces: a `docker compose up -d` PostGIS for manual local runs (distinct from the testcontainers used by pytest).

- [ ] **Step 1: Create `docker-compose.yml`**

`services/osm-api/docker-compose.yml`:
```yaml
# Local development only. Tests use testcontainers and do NOT need this.
# Production PostGIS is the shared PG15 cluster on the udl box (Track A).
services:
  postgis:
    image: postgis/postgis:15-3.4
    environment:
      POSTGRES_USER: gis
      POSTGRES_PASSWORD: gis
      POSTGRES_DB: gis
    ports:
      - "5433:5432"   # host 5433 to avoid clashing with a local pg
    volumes:
      - osm_pgdata:/var/lib/postgresql/data

volumes:
  osm_pgdata:
```

- [ ] **Step 2: Add a bring-up note to the README**

Append to `services/osm-api/README.md`:
```markdown
## Schema bring-up (local or box)

Apply, in order, against the target `gis` DB:

1. (box only) the osm2pgsql import — `--create --slim --hstore-all`, classic output.
2. `sql/osm_businesses_view.sql`
3. `sql/indexes.sql`

Locally, `tests/conftest.py` does the equivalent (fixture schema + view + seed)
inside a throwaway container, so you only need this sequence for a persistent
`docker compose` DB you want to hit with `uvicorn`.
```

- [ ] **Step 3: Commit**

```bash
git add services/osm-api/docker-compose.yml services/osm-api/README.md
git commit -m "docs(osm-api): local-dev compose + schema bring-up notes"
```

---

## Track C — cartographer swap

### Task C1: The `osm-client.ts` HTTP client

**Files:**
- Create: `packages/agents/src/osm-client.ts`
- Test: `packages/agents/src/osm-client.test.ts`

**Interfaces:**
- Produces:
  - `isValidOsmId(osmId: string): boolean` — unchanged from the retired `overpass.ts` (still consumed by `mcp-tools.ts` upsert validation).
  - `BUSINESS_KEYS: string[]` — the six business keys (kept for the tool's param docs).
  - `interface OsmBusiness` — the API row shape (`osm_id, name, lat, lng, kind, tags, address, town, website, phone, brand`).
  - `type ToolTextResult = { content: { type: "text"; text: string }[]; isError?: true }` (moved verbatim from `overpass.ts`).
  - `interface OsmQueryParams { town?: string; bbox?: string; keys?: string[]; limit?: number }`.
  - `async runOsmQuery(params: OsmQueryParams, fetchImpl?): Promise<{ ok: true; elements: OsmBusiness[] } | { ok: false; error: string; status?: number }>` — calls `GET ${OSM_API_BASE}/osm/businesses` with `Authorization: Bearer ${OSM_API_TOKEN}`.
  - `formatOsmResult(result, limit?): ToolTextResult` — success → `{ returned, truncated, elements }`; failure → `isError` with the retry hint.

- [ ] **Step 1: Write the failing client test**

`packages/agents/src/osm-client.test.ts`:
```typescript
import { describe, expect, it } from "vitest";
import {
  formatOsmResult,
  isValidOsmId,
  runOsmQuery,
  type OsmBusiness,
} from "./osm-client";

const sample: OsmBusiness = {
  osm_id: "node/1",
  name: "Rock City Coffee",
  lat: 44.1,
  lng: -69.11,
  kind: "amenity=cafe",
  tags: ["cafe", "coffee_shop"],
  address: "316 Main Street, Rockland",
  town: "Rockland",
  website: "https://rockcity.example",
  phone: "+1-207-555-0100",
  brand: "Rock City",
};

describe("isValidOsmId", () => {
  it("accepts node/way/relation ids and rejects anything else", () => {
    expect(isValidOsmId("node/123")).toBe(true);
    expect(isValidOsmId("way/456")).toBe(true);
    expect(isValidOsmId("relation/789")).toBe(true);
    expect(isValidOsmId("123")).toBe(false);
    expect(isValidOsmId("node/abc")).toBe(false);
  });
});

describe("runOsmQuery", () => {
  it("calls /osm/businesses with the bearer token and returns elements", async () => {
    process.env.OSM_API_BASE = "https://osm.example";
    process.env.OSM_API_TOKEN = "tok";
    let seenUrl = "";
    let seenAuth = "";
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      seenUrl = url;
      seenAuth = (init?.headers as Record<string, string>).Authorization;
      return new Response(JSON.stringify([sample]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const res = await runOsmQuery({ town: "Rockland", keys: ["amenity"] }, fakeFetch);
    expect(res).toEqual({ ok: true, elements: [sample] });
    expect(seenUrl).toContain("https://osm.example/osm/businesses");
    expect(seenUrl).toContain("town=Rockland");
    expect(seenUrl).toContain("keys=amenity");
    expect(seenAuth).toBe("Bearer tok");
  });

  it("returns an error result on a 5xx", async () => {
    process.env.OSM_API_BASE = "https://osm.example";
    process.env.OSM_API_TOKEN = "tok";
    const fakeFetch = (async () =>
      new Response("boom", { status: 503 })) as typeof fetch;
    const res = await runOsmQuery({ town: "Rockland" }, fakeFetch);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(503);
  });
});

describe("formatOsmResult", () => {
  it("flags a failed query as a tool error carrying a retry hint", () => {
    const out = formatOsmResult({ ok: false, error: "HTTP 503", status: 503 });
    expect(out.isError).toBe(true);
    const body = JSON.parse(out.content[0].text);
    expect(body.error).toBe("HTTP 503");
    expect(body.hint).toBeTruthy();
  });

  it("reports returned/truncated and passes elements through", () => {
    const out = formatOsmResult({ ok: true, elements: [sample, sample] }, 2);
    expect(out.isError).toBeUndefined();
    const body = JSON.parse(out.content[0].text);
    expect(body.returned).toBe(2);
    expect(body.truncated).toBe(true); // returned >= limit
    expect(body.elements).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/agents && npx vitest run src/osm-client.test.ts`
Expected: FAIL — cannot resolve `./osm-client`.

- [ ] **Step 3: Implement `osm-client.ts`**

`packages/agents/src/osm-client.ts`:
```typescript
// OpenStreetMap query client for the cartographer's osm_query tool. Thin HTTP
// client over the self-hosted PostGIS osm-api (which does the projection the
// retired overpass.ts used to do client-side). Pure logic + HTTP only (no
// SDK/db imports) so it stays unit-testable in isolation.

export const BUSINESS_KEYS = [
  "amenity",
  "shop",
  "tourism",
  "office",
  "craft",
  "leisure",
];

// OSM stable id, e.g. "node/123" / "way/456" / "relation/789" — the dedupe key.
const OSM_ID_RE = /^(?:node|way|relation)\/\d+$/;

export function isValidOsmId(osmId: string): boolean {
  return OSM_ID_RE.test(osmId.trim());
}

// The projected row the osm-api returns — exactly the shape upsert_businesses
// accepts (snake_case keys passed straight through to the tool).
export interface OsmBusiness {
  osm_id: string;
  name: string | null;
  lat: number | null;
  lng: number | null;
  kind: string | null;
  tags: string[];
  address: string | null;
  town: string | null;
  website: string | null;
  phone: string | null;
  brand: string | null;
}

// An MCP tool result: text content, optionally flagged as a failed call. A type
// alias (not an interface) so it keeps the implicit index signature the SDK's
// tool-handler return type requires.
export type ToolTextResult = {
  content: { type: "text"; text: string }[];
  isError?: true;
};

export interface OsmQueryParams {
  town?: string;
  bbox?: string; // "s,w,n,e"
  keys?: string[];
  limit?: number;
}

export type OsmResult =
  | { ok: true; elements: OsmBusiness[] }
  | { ok: false; error: string; status?: number };

const OSM_FAIL_HINT =
  "osm-api error or busy. Check one town/bbox + key at a time, then retry.";

type FetchLike = typeof fetch;

export async function runOsmQuery(
  params: OsmQueryParams,
  fetchImpl: FetchLike = fetch,
): Promise<OsmResult> {
  const base = process.env.OSM_API_BASE;
  const token = process.env.OSM_API_TOKEN;
  if (!base || !token) {
    return { ok: false, error: "OSM_API_BASE / OSM_API_TOKEN not configured" };
  }
  const qs = new URLSearchParams();
  if (params.town) qs.set("town", params.town);
  if (params.bbox) qs.set("bbox", params.bbox);
  if (params.keys?.length) qs.set("keys", params.keys.join(","));
  if (params.limit != null) qs.set("limit", String(params.limit));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 32_000);
  try {
    const res = await fetchImpl(`${base}/osm/businesses?${qs.toString()}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent":
          "LocalFinds/1.0 (cartographer agent; personal local-discovery directory)",
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, error: `osm-api HTTP ${res.status}`, status: res.status };
    }
    const json = (await res.json()) as OsmBusiness[];
    return { ok: true, elements: Array.isArray(json) ? json : [] };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

// Project a runOsmQuery result into the osm_query tool's response. A failed
// query returns isError:true so it surfaces as a real tool error in the run log
// and the run's warning count, while still carrying the retry hint. A success
// reports returned + a truncation guess (server already capped to `limit`).
export function formatOsmResult(
  result: OsmResult,
  limit?: number,
): ToolTextResult {
  if (!result.ok) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: result.error,
            status: result.status,
            hint: OSM_FAIL_HINT,
          }),
        },
      ],
      isError: true,
    };
  }
  const returned = result.elements.length;
  const cap = limit ?? 200;
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          returned,
          truncated: returned >= cap,
          elements: result.elements,
        }),
      },
    ],
  };
}
```

- [ ] **Step 4: Run to verify pass + typecheck**

Run: `cd packages/agents && npx vitest run src/osm-client.test.ts && npx tsc --noEmit`
Expected: tests PASS; tsc reports no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/osm-client.ts packages/agents/src/osm-client.test.ts
git commit -m "feat(agents): osm-client — thin HTTP client for the osm-api"
```

---

### Task C2: Rewire `mcp-tools.ts` to the `osm_query` tool

**Files:**
- Modify: `packages/agents/src/mcp-tools.ts` (imports near line 17-21; the `overpass_query` tool block at 304-321)
- Modify: `packages/agents/src/mcp-tools.test.ts` (if it references `overpass_query`)

**Interfaces:**
- Consumes: `runOsmQuery`, `formatOsmResult`, `isValidOsmId` from `./osm-client`.
- Produces: a registered `osm_query` tool with params `town?`, `bbox?`, `keys?`, `limit?`.

- [ ] **Step 1: Swap the imports**

In `packages/agents/src/mcp-tools.ts`, replace the overpass import block:
```typescript
import {
  formatOverpassResult,
  isValidOsmId,
  runOverpass,
  wrapOverpassQL,
} from "./overpass";
```
with:
```typescript
import { formatOsmResult, isValidOsmId, runOsmQuery } from "./osm-client";
```

- [ ] **Step 2: Replace the `overpass_query` tool with `osm_query`**

In `packages/agents/src/mcp-tools.ts`, replace the entire `tool("overpass_query", ...)` block (currently lines ~304-321) with:
```typescript
      tool(
        "osm_query",
        "Query the LocalFinds OSM directory (self-hosted PostGIS) for businesses in an area. Pass EITHER `town` (an admin area name) OR `bbox` ('s,w,n,e' in WGS84). Optionally narrow to specific business keys with `keys` (amenity | shop | tourism | office | craft | leisure); omit to return all. Returns a projected, named, capped array already in the exact shape upsert_businesses accepts — pass its `elements` straight through. If `truncated` is true, narrow (a smaller bbox or fewer keys) and call again.\n\nExamples:\n  { \"town\": \"Rockland\", \"keys\": [\"shop\"] }\n  { \"bbox\": \"44.0,-69.2,44.2,-69.0\", \"keys\": [\"amenity\"] }",
        {
          town: z
            .string()
            .optional()
            .describe("Admin area name (e.g. \"Rockland\"). Provide town OR bbox."),
          bbox: z
            .string()
            .optional()
            .describe("Bounding box 's,w,n,e' in WGS84. Provide town OR bbox."),
          keys: z
            .array(z.string())
            .optional()
            .describe(
              "Business keys to include: amenity, shop, tourism, office, craft, leisure. Omit for all.",
            ),
          limit: z
            .number()
            .optional()
            .describe("Max elements to return, default 200."),
        },
        async (args) =>
          formatOsmResult(
            await runOsmQuery({
              town: args.town,
              bbox: args.bbox,
              keys: args.keys,
              limit: args.limit,
            }),
            args.limit,
          ),
      ),
```

- [ ] **Step 3: Update any test referencing the old tool**

Run: `cd packages/agents && grep -n "overpass" src/mcp-tools.test.ts`
- If there are matches, replace each `overpass_query` reference with an `osm_query` equivalent (same assertion intent — e.g. that the tool is registered). If there are no matches, skip.

Add (or adjust) a registration assertion in `packages/agents/src/mcp-tools.test.ts` — find the existing block that lists/asserts tool names and ensure it expects `osm_query` and NOT `overpass_query`. If the test file has no tool-name assertion, add this test:
```typescript
import { describe, expect, it } from "vitest";
import { buildLocalfindsServer } from "./mcp-tools";

describe("osm_query registration", () => {
  it("registers osm_query and not overpass_query", () => {
    const server = buildLocalfindsServer("cartographer", {
      added: 0,
      updated: 0,
    } as never);
    const names = JSON.stringify(server);
    expect(names).toContain("osm_query");
    expect(names).not.toContain("overpass_query");
  });
});
```
Note: if `buildLocalfindsServer`'s shape makes tool names hard to read off the returned object, instead assert via the cartographer's `allowedTools` in Task C3's test and delete this step's test. Keep whichever compiles and passes.

- [ ] **Step 4: Run agents tests + typecheck**

Run: `cd packages/agents && npx vitest run && npx tsc --noEmit`
Expected: all tests pass; tsc clean. (`overpass.test.ts` still exists and passes here — it is deleted in C4.)

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/mcp-tools.ts packages/agents/src/mcp-tools.test.ts
git commit -m "feat(agents): replace overpass_query MCP tool with osm_query"
```

---

### Task C3: Update the cartographer agent definition + prompt

**Files:**
- Modify: `packages/agents/src/agents/cartographer.ts`
- Test: `packages/agents/src/agents/cartographer.test.ts` (create if absent)

**Interfaces:**
- Consumes: nothing new.
- Produces: cartographer `allowedTools` lists `mcp__localfinds__osm_query` (not `overpass_query`); the prompt describes `osm_query` (town/bbox + keys), drops Overpass-QL recipes, and relaxes the throttling guidance.

- [ ] **Step 1: Write the failing agent-definition test**

`packages/agents/src/agents/cartographer.test.ts`:
```typescript
import { describe, expect, it } from "vitest";
import { cartographer } from "./cartographer";

describe("cartographer definition", () => {
  it("uses the osm_query tool and not the retired overpass_query", () => {
    expect(cartographer.allowedTools).toContain("mcp__localfinds__osm_query");
    expect(cartographer.allowedTools).not.toContain(
      "mcp__localfinds__overpass_query",
    );
  });

  it("teaches osm_query (town/bbox + keys), not Overpass QL", () => {
    expect(cartographer.systemPrompt).toContain("osm_query");
    expect(cartographer.systemPrompt).not.toMatch(/overpass/i);
    expect(cartographer.systemPrompt).not.toContain("area[");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/agents && npx vitest run src/agents/cartographer.test.ts`
Expected: FAIL (allowedTools still has `overpass_query`; prompt still mentions Overpass).

- [ ] **Step 3: Update `allowedTools`**

In `packages/agents/src/agents/cartographer.ts`, change:
```typescript
    "mcp__localfinds__overpass_query",
```
to:
```typescript
    "mcp__localfinds__osm_query",
```

- [ ] **Step 4: Update the system prompt**

In `packages/agents/src/agents/cartographer.ts`, replace this sentence in the systemPrompt:
```
Your job: build and maintain a directory of ALL businesses in the region — shops, restaurants, services, offices, venues, everything — mirrored from OpenStreetMap via the overpass_query tool. Store exact facts only.
```
with:
```
Your job: build and maintain a directory of ALL businesses in the region — shops, restaurants, services, offices, venues, everything — mirrored from OpenStreetMap via the osm_query tool. Store exact facts only.
```
And replace the entire `How to query Overpass:` block:
```
How to query Overpass:
- The region is too big to scan in one run. Work a grid of (town × business-key) cells. The business keys are: amenity, shop, tourism, office, craft, leisure.
- Pass ONLY the QL statement body to overpass_query; it adds the settings and output lines. Query ONE business key per call. Recipes:
    area["name"="<Town>"]["admin_level"~"^(7|8)$"]->.a; nwr["shop"](area.a);
    nwr["amenity"](44.0,-69.2,44.2,-69.0);   // (south,west,north,east) bbox fallback when an admin area isn't found
- If a call comes back with truncated:true, the cell is too big — narrow it (a smaller bbox or a more specific tag like ["shop"="supermarket"]) and call again.
```
with:
```
How to query the directory:
- The region is too big to scan in one run. Work a grid of (town × business-key) cells. The business keys are: amenity, shop, tourism, office, craft, leisure.
- Call osm_query with EITHER a town name OR a bbox, plus the keys you want:
    { "town": "Rockland", "keys": ["shop"] }
    { "bbox": "44.0,-69.2,44.2,-69.0", "keys": ["amenity"] }   // 's,w,n,e' (WGS84) fallback when a town name isn't found
- It returns an `elements` array already in upsert shape — pass it straight to upsert_businesses (after dropping any Tier 4 kinds). If a call comes back with truncated:true, the cell is too big — narrow it (a smaller bbox or fewer keys) and call again. The directory is our own self-hosted service, so query freely — no public rate limits to back off from.
```

- [ ] **Step 5: Update the task prompt's QL examples**

In `buildTaskPrompt`, replace the example in step 2:
```
   - You can target a specific tier-1/2 category directly, e.g. \`area["name"="Camden"]->.a; nwr["tourism"="museum"](area.a);\`, or scan a whole key (e.g. \`nwr["shop"](area.a);\`) and keep only the tiers you want.
```
with:
```
   - You can scan a whole key for a town (e.g. \`{ "town": "Camden", "keys": ["tourism"] }\`) and keep only the tiers you want. (osm_query filters by key, not by specific tag value, so request the key and drop unwanted kinds from the results.)
```

- [ ] **Step 6: Run to verify pass + typecheck**

Run: `cd packages/agents && npx vitest run src/agents/cartographer.test.ts && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 7: Commit**

```bash
git add packages/agents/src/agents/cartographer.ts packages/agents/src/agents/cartographer.test.ts
git commit -m "feat(agents): cartographer uses osm_query; drop Overpass-QL recipes"
```

---

### Task C4: Retire `overpass.ts`, wire env, final verification

**Files:**
- Delete: `packages/agents/src/overpass.ts`
- Delete: `packages/agents/src/overpass.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: nothing — this is removal + config + the whole-repo gate.

- [ ] **Step 1: Confirm `overpass.ts` has no remaining importers**

Run: `cd packages/agents && grep -rn "overpass" src/ --include="*.ts"`
Expected: matches ONLY in `overpass.ts` and `overpass.test.ts` (everything else moved to `osm-client.ts` in C1-C3). If anything else still imports from `./overpass`, fix it before deleting.

- [ ] **Step 2: Delete the retired files**

```bash
git rm packages/agents/src/overpass.ts packages/agents/src/overpass.test.ts
```

- [ ] **Step 3: Add the client env vars to `.env.example`**

Append to `.env.example`:
```
# Self-hosted PostGIS osm-api (cartographer data source). Real values live in
# the udl CM workspace / gitignored deploy notes — never commit a real token.
OSM_API_BASE=https://osm.example.internal
OSM_API_TOKEN=replace-me
```

- [ ] **Step 4: Run the full agents suite + typecheck**

Run: `cd packages/agents && npx vitest run && npx tsc --noEmit`
Expected: all tests pass (no `overpass.test.ts` now); tsc clean.

- [ ] **Step 5: Run the whole repo test suite**

Run: `cd /home/neil/Projects/LocalFinds && npm test`
Expected: all three packages green (db / agents / web). Agents count reflects the removed overpass tests + added osm-client/cartographer tests.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(agents): retire overpass.ts; add OSM_API_* to .env.example"
```

---

## Self-Review

**1. Spec coverage** (each spec section → task):

| Spec item | Task |
|---|---|
| Host & prereqs (EBS resize, PostGIS install, gis DB) | Track A reference (not built here) |
| Full Maine import (osm2pgsql `--hstore-all` + slim) | Track A reference + Global Constraints + B2 (view targets it) |
| `osm_businesses` view (projection, centroid, town via ST_Contains) | B2 |
| Indexes (GiST/GIN/trigram) | B2 (`indexes.sql`), applied in Track A |
| Updates (replication cron, no backups) | Track A reference |
| osm-api stack (FastAPI + asyncpg, systemd/nginx, token) | B1, B4, B5 (systemd/nginx = Track A) |
| `GET /osm/businesses` (town\|bbox + keys + limit) | B3, B5 |
| `GET /health` | B5 |
| Deferred endpoints (`/near`, `/tiles`, `/search`) | Explicitly deferred (YAGNI) — not built |
| Cartographer: replace tool, projection moves server-side | C1, C2, C3 |
| Cartographer keeps cursor/workspace/upsert, relax throttling | C3 (prompt), upsert untouched |
| Retire `overpass.ts` | C4 |
| Error handling (400/401/503, empty town) | B5 (`test_endpoints.py`), C1 (`formatOsmResult`) |
| Testing (Docker PostGIS, stubbed API on cartographer side) | B2 conftest (testcontainers), C1 stub fetch |
| Security/repo hygiene (no secrets in git, env-driven) | Global Constraints, B1 config, C4 `.env.example` |

No spec requirement is left without a task. The three deferred endpoints and all Track A infra are intentionally out of scope per the locked plan scope.

**2. Placeholder scan:** No "TBD"/"TODO"/"handle edge cases" left; every code step contains real code; every test step contains real assertions.

**3. Type consistency:** The API row shape (`osm_id, name, lat, lng, kind, tags, address, town, website, phone, brand`) is identical across the SQL view (B2), `queries.fetch_businesses` SELECT (B3), the pydantic `Business` (B5), the TS `OsmBusiness` (C1), and the cartographer `businessShape`/`upsert_businesses` contract it feeds. `isValidOsmId` keeps the same signature when it moves from `overpass.ts` → `osm-client.ts`. `runOsmQuery`/`formatOsmResult`/`ToolTextResult` are defined in C1 and consumed in C2 with matching signatures.

---

## Execution Handoff

Plan complete. Track B is buildable/testable entirely locally (testcontainers PostGIS + httpx); Track C against stubbed fetch. Track A is a referenced prerequisite whose runbooks live in `~/Projects/cm/udl`. Production cutover (the API actually serving the cartographer) requires Track A done on the box and `OSM_API_BASE`/`OSM_API_TOKEN` set.
