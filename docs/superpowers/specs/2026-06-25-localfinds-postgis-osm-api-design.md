# LocalFinds PostGIS OSM-API — Design (v1)

**Date:** 2026-06-25
**Status:** Approved design, pre-implementation
**Branch:** `feat/postgis-osm-api`

## Summary

Stand up a self-hosted, PostGIS-backed HTTP API that replaces the public
Overpass API as LocalFinds' OSM data source. The service holds a full import of
Maine's OSM data, exposes a query endpoint shaped to what the cartographer
already consumes, and is designed to grow into proximity search, server-side
clustering, and full-text search over annotations.

It co-locates on the `was` EC2 box (the "Web Application Server"; UniDataLog and
LocalFinds are apps already running on it). The existing SQLite `businesses`
table, closure sweep, read-time tiering, web app, and `deploy:sync-content` flow
are **unchanged** — only the cartographer's data *source* changes.

## Motivation

LocalFinds' cartographer agent does mechanical ETL: query Overpass for named
elements in a region, transcribe them into the `businesses` table. The public
Overpass endpoints rate-limit hard on bulk/region sweeps, which caps statewide
coverage. A self-hosted PostGIS service removes that ceiling (our box, our
indexes, no shared quota) and — unlike a drop-in Overpass self-host — becomes a
general geospatial backend we can later query for proximity, clustering, and
search directly from the web app.

### Why PostGIS over self-hosting Overpass

A protocol-compatible Overpass self-host would be a near-zero-code swap for the
cartographer, but it does **not** use PostGIS (Overpass has its own backend) and
gives us nothing toward the spatial features we want next. PostGIS earns its
added complexity precisely because those features — proximity search,
server-side clustering, full-text search joined to our own annotations — are the
eventual goal. We accept rewriting the cartographer's query tool (a localized
change) in exchange for that runway.

## Architecture

```
Geofabrik (maine-latest.osm.pbf + daily diffs)
        │  osm2pgsql (classic + --hstore + slim) + osm2pgsql-replication cron
        ▼
   PostGIS (gis db)  ──  planet_osm_* (full tags) + osm_businesses view + admin
        │
   osm-api (Python/FastAPI + asyncpg, uvicorn/systemd, 127.0.0.1, nginx + token)
        ▲
        │  HTTPS  (replaces the public Overpass endpoint)
   cartographer agent (runs locally)  →  upsert_businesses  →  SQLite businesses
        │
   deploy:sync-content  →  prod SQLite  (unchanged)
```

Three new components, all on `was`: **PostGIS**, the **osm-api service**, and an
**osm2pgsql-replication update cron**. Everything downstream of the cartographer
is untouched.

## Components

### 1. Host & prerequisites (`was`)

- **Resize root EBS volume 15 → 30 G**, grown online (`growpart` + `resize2fs`),
  no downtime. The root volume is currently 15 G at ~80 % used with only ~3 G
  free, and `/var/lib/postgresql` shares it with the OS and the running apps. A
  database growing on that shared volume risks filling root and taking down all
  apps; resizing removes the constraint and gives a full Maine import room to
  spare (~18 G free after resize).
- Install `postgresql-15-postgis-3`, `osm2pgsql`, `osm2pgsql-replication`
  (PostgreSQL 15 is already installed from the pgdg repo; PostGIS is not).
- Create a `gis` database; `CREATE EXTENSION postgis;` (and `hstore`).

### 2. Data — full Maine import

- osm2pgsql in **classic output + `--hstore` + slim** loads
  `maine-latest.osm.pbf` into `planet_osm_point / line / polygon / roads`, all
  tags preserved in an hstore column. Slim tables are retained to enable
  incremental replication.
- **`osm_businesses` view** over the imported tables: named features carrying a
  business key (`amenity, shop, tourism, office, craft, leisure` — widenable, it
  is just the view's `WHERE`), polygon/relation geometries reduced to a
  representative point via `ST_PointOnSurface`, projected to the columns the
  cartographer's upsert expects: `osm_id` (`"node/123"` form), `name`, `lat`,
  `lng`, `kind` (primary `key=value`), `tags` (string array), `website`,
  `phone`, `brand`, `address`, `town`.
- **Town resolution** via `ST_Contains` against administrative boundaries
  (`boundary=administrative`, `admin_level` 7/8) already present in
  `planet_osm_polygon` — no separate import.
- **Indexes:** GiST on geometry, GIN on hstore tags, trigram on `name` (seeds
  the future FTS endpoint).

### 3. Updates

- **`osm2pgsql-replication`** applies Geofabrik Maine diffs on a **daily** cron.
  Incremental (slim tables make this possible), no full reload.
- The DB is fully rebuildable from Geofabrik, so **no backups in v1** — on loss,
  re-import.
- SQLite `businesses` freshness is unchanged: driven by cartographer run cadence,
  which now reads fresh PostGIS instead of throttled public Overpass.

### 4. The osm-api service

- **Stack:** Python 3.12 + FastAPI + asyncpg, with PostGIS doing the spatial
  work. Lives in its own `services/osm-api/` (pyproject, ruff, pytest) — an
  independently deployed service, not a TS monorepo workspace.
- **Run:** `uvicorn`/`gunicorn` under systemd, bound to `127.0.0.1:<port>`,
  nginx-proxied with a token header (the box is public-facing; only the
  cartographer calls it — no rate limit for our own token).
- **v1 endpoints:**
  - `GET /osm/businesses?town=<name>|bbox=s,w,n,e&keys=<csv>&limit=<n>` →
    JSON array in the exact projected shape `upsertBusinesses` accepts.
  - `GET /health`.
- **Deferred endpoints (schema/indexes already accommodate):**
  - `GET /osm/businesses/near?lat&lng&radius` — KNN proximity (`geom <-> point`).
  - `GET /osm/tiles/{z}/{x}/{y}` — server-side clustering via `ST_AsMVT`.
  - `GET /osm/search?q=` — trigram/tsvector full-text search.

### 5. Cartographer changes

- Replace the `overpass_query` MCP tool and its Overpass-QL "recipe" prompt with
  a thin `osm_query` tool that calls `/osm/businesses` (town or bbox + keys).
  The element-projection logic that lived in `overpass.ts` moves server-side
  into the view/API.
- The agent keeps its coverage-notes cursor, its workspace, and the
  `upsert_businesses` path untouched. Throttling/backoff in the tool is relaxed.
- `overpass.ts` is retired.

### 6. Unchanged

SQLite `businesses` table, `last_seen_at` closure sweep, read-time tier/chain
ranking (`categories.json` + `brand`), the Next.js web app, and
`deploy:sync-content` (which still merges discovery data into prod while
preserving prod-side `feedback` and `finds.status`).

## Data flow

1. Daily cron: `osm2pgsql-replication` pulls Geofabrik Maine diffs into PostGIS.
2. Cartographer run (local): `osm_query` → osm-api → PostGIS, per town×key cell;
   results upserted into local SQLite `businesses` (dedupe on `osm_id`,
   `last_seen_at` bumped).
3. Closure sweep marks businesses not seen this run.
4. `deploy:sync-content` pushes businesses/finds/etc. to prod SQLite.

## Error handling

- **osm-api:** invalid `bbox`/`town`/`keys` → 400 with a clear message; unknown
  town → empty result (not an error); DB unavailable → 503; missing/invalid
  token → 401. Responses cap at `limit` (sane default + max).
- **Cartographer `osm_query` tool:** network/5xx → bounded retry with backoff
  (relaxed vs the old public-Overpass limits), then surface an error with a
  retry hint, matching the existing tool's failure contract.
- **Replication cron:** logs to a file; a failed diff run leaves the last good
  state in place (osm2pgsql-replication is transactional per run).

## Testing

- **osm-api (pytest):** spin a throwaway PostGIS (Docker) loaded with a small
  fixture PBF; assert the SQL → projected-shape mapping (`osm_id` form,
  centroid, tag/brand extraction, town resolution) and that responses satisfy
  the `upsertBusinesses` input contract. Endpoint tests for 200/400/401/503.
- **Cartographer:** `osm_query` tool tested against a stubbed API (success,
  empty, error) — no live network.

## Explicitly deferred (YAGNI)

- Web app reading PostGIS directly (it keeps reading SQLite in v1).
- The three spatial/search endpoints (`/near`, `/tiles`, `/search`).
- Moving LocalFinds annotations (`status`, `notes`, `tags`) into Postgres.
- Splitting PostGIS/osm-api onto a dedicated instance (co-located for now;
  revisit if traffic grows).
- Backups for the OSM DB (rebuildable from Geofabrik).

## Open questions

None blocking. Port number, exact nginx path/subdomain, and token storage are
deployment details resolved during implementation (kept out of the public repo).

## Security / repo hygiene

This repo is public. This document and all committed code keep the EC2 IP,
hostnames-as-secrets, ports, and auth tokens **out of git** — service config is
env-var driven; concrete values live only in the (gitignored) deploy skill and
on the box.
