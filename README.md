# LocalFinds

A single-user web app showing a curated feed of local finds — events, org
announcements, official notices — for one configurable region, gathered by
scheduled Claude agents that learn your taste from feed feedback.

## Why it exists

Local events, notices, and announcements are scattered across town sites,
library calendars, and local papers, most with no feed. LocalFinds gathers them
for one region into a single feed. Scheduled Claude agents do the collecting;
your thumbs, stars, and hides train a taste profile they read before each run.

Single-user and self-hosted: one region, one person's taste, and all personal
data (database, taste profile, agent notes) stays local, never in git.

## Version Alpha 1

This application is an alpha version for discovery.

### Selected resources include:

- OpenStreetMap
- PostGIS (spatial Postgres)
- Leaflet (map JS library)
- Custom agents for managing site data and content

### Remaining tasks

- Clean up UI/UX
  - Breadcrumb, page title, navigation indicators
- Tag filters: full-blown feature with schema upgrades
  - tightly integrates/couples with OSM data schemes
- Manually add new source (CRUD)

## Version Beta 1

Live user access on a working platform.

### Planned changes include:

- Integrate with AWS — more data storage, more memory
- Individual user customization. Signup, auth, etc.
- Downloaded OpenStreetMap data to feed app, gets regular updates
- AI agent upgrades:
  - Interviewer to customize user setup (location, routes, interests, etc.)
  - More efficient web browsing/searching
  - User credits

## Architecture

- **apps/web** — Next.js feed UI (`/`), source registry (`/sources`), places
  directory (`/places`), agent profiles + run history (`/agents`).
- **packages/agents** — Claude Agent SDK agents. Four run sequentially on a
  schedule: **scout** (web-searches for new finds), **source-keeper** (maintains
  the source registry + per-site notes), **prospector** (discovery-only local
  B2B lead-gen — qualifies the places directory against an Ideal Customer Profile
  and saves matches as `lead`-type finds), and **curator** (dedupes, prunes,
  expires, and keeps the taste profile). **concierge** runs on demand
  (`--query "..."`) to scan for and save the places a specific search asks for.
  The OSM places directory itself is a Postgres materialized view (refreshed
  daily), not an agent. Finds carry a free-text `type` (`event` by default,
  `lead`, …); the feed shows all types and `/feed?type=lead` narrows it.
- **packages/db** — Postgres/PostGIS (raw parameterized SQL) for exact facts
  (finds, sources, places, feedback, runs). Anything fuzzy lives in per-agent
  markdown under `data/agents/<name>/` (profile.md is yours to edit too).
- **data/** — ALL runtime state and personal config. Gitignored except
  `*.example` templates: keep PII out of git.

## Local development

Run the app and agents against a local Postgres/PostGIS seeded from live:

1. `docker compose up -d` — starts PostGIS on `localhost:5434`.
2. `cp .env.local.example .env` and copy the same `LOCALFINDS_DATABASE_URL`
   into `apps/web/.env.local` (Next only auto-loads env from `apps/web`).
3. In another shell: `bash scripts/db-tunnel.sh` (opens the tunnel to live).
4. `npm run db:pull` — snapshots a live subset into `data/db/snapshots/`.
5. `npm run db:load` — rebuilds the local DB from the latest snapshot.
6. `npm run dev` (web) and/or `npm run agent <name> -- ...` (agents) — both
   now hit `localhost:5434`.

Re-run `db:pull` + `db:load` anytime to refresh dev data. The OSM directory is
a frozen snapshot (no planet import locally); local `save_place` writes work and
resolve town from the snapshotted region boundaries.

## Setup

```sh
npm install
cp .env.example .env                                  # add ANTHROPIC_API_KEY + DB URL
cp data/config/region.md.example data/config/region.md   # describe YOUR region
# bring up the database — see "Local development" above (docker compose + db:load)
npm run dev                                           # http://localhost:3000
```

The schema is applied from the canonical SQL migrations in `db/migrations/*.sql`.
After pulling changes that add a new migration, re-run `npm -w @localfinds/db run migrate`
to apply them to your existing database.

## Running agents

```sh
npm run agent -- scout --max-turns 8                    # cheap capped test run
npm run agent -- prospector --max-turns 8               # qualify the directory into leads (needs an ICP profile)
npm run agent -- concierge --query "..." --max-turns 8  # on-demand scan for specific places
npm run agents:all                                      # full scheduled roster, sequential
npm test                                                # vitest (all packages)
```

The places directory is a Postgres materialized view over an OpenStreetMap
import (`planet_osm_*`), refreshed daily — there is no crawl step. Agents read
it as the local place catalog; the concierge and prospector write new or
annotated places back through the database.

Schedule with cron once region + API key are real (see the comment in
`scripts/run-agents.sh`):

```
0 7,12,18 * * * /home/neil/Projects/LocalFinds/scripts/run-agents.sh
```

Budget guardrails: per-agent `maxTurns`, `maxBudgetUsd` ($1/run default),
prompt-level search caps. Per-run cost is logged to the `runs` table and
totaled on `/agents`.

Watch a run live — or read any past run's full transcript — on `/agents`: each
run streams a structured event log into the `localfinds.run_events` table (Postgres),
surfaced via Server-Sent Events and a per-run detail page (`/agents/runs/<id>`).

## Deploy

The app is served from a single host behind nginx (public reads, auth-gated
writes), reading the live Postgres database directly. Deploys run from this repo root on a clean tree — no sudo.
The real infra values (host, path, process name) live in the gitignored
`data/config/deploy.env`; the `deploy-localfinds` skill documents them.

```sh
npm run deploy                 # full: gate → deploy-code → migrate
npm run deploy -- --dry-run    # preview every remote action, change nothing
```

Composable stages: `deploy:gate` (blocks unless on `main`, tree clean, tests +
`tsc` pass), `deploy:code` (rsyncs the tree, installs, builds), `deploy:migrate`
(dumps the prod Postgres DB, then applies pending `db/migrations/*.sql` via the
tracked runner, then reloads pm2 and verifies GET=200 / POST=401).

Code ships before migrations apply, and the app reloads only after the migration
runs, so it never serves new code against an unmigrated schema. After a deploy,
sanity-check the site:

```sh
curl -s -o /dev/null -w "%{http_code}\n" https://localfinds.me/        # 200
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://localfinds.me/ # 401
```

## Using your own region

The committed `data/config/*.example` files describe a sample region (Knox
County, ME), and every config falls back to its `.example`, so the app runs out
of the box. To cover your own area:

```sh
# Required — agents read this verbatim, and it has no fallback:
cp data/config/region.md.example data/config/region.md    # describe your region

# For the dashboard map — list your towns, then fetch their outlines from OSM:
cp data/config/towns.json.example data/config/towns.json  # name + bbox per town
npm run boundaries:fetch                                  # → town-boundaries.json
```

`categories.json` (search-priority tiers) and `map-categories.json` (map themes)
are optional — copy those `.example`s only to customize ranking or map colors.
Each agent's `profile.md` bootstraps from its `.example` on first run and is
yours to edit anytime.
