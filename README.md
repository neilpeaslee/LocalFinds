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

This README describes what LocalFinds does **right now** — how to run it,
develop it, and deploy it. Where the project is headed lives in
[VISION.md](VISION.md).

## Architecture

- **apps/web** — Next.js UI: dashboard with the region map (`/`), the feed
  (`/feed`), places directory (`/places`), source registry (`/sources`), agent
  profiles + run history (`/agents`).
- **packages/agents** — Claude Agent SDK agents. Four run sequentially on a
  schedule: **scout** (web-searches for new finds), **source-keeper** (maintains
  the source registry + per-site notes), **prospector** (discovery-only local
  B2B lead-gen — qualifies the places directory against an Ideal Customer Profile
  and saves matches as `lead`-type finds), and **curator** (dedupes, prunes,
  expires, and keeps the taste profile). **concierge** runs on demand
  (`--query "..."`) to scan for and save the places a specific search asks for.
  The **interviewer** runs interactively (`npm run interview`) and builds your
  region/category/ICP config through a conversation (or a prepared
  questionnaire), test-runs the prospector on the result, and gates every
  config write behind a before/after diff you confirm. The OSM places directory itself is a Postgres materialized view (refreshed
  daily), not an agent. Finds carry a free-text `type` (`event` by default,
  `lead`, …); the feed shows all types and `/feed?type=lead` narrows it.
- **packages/db** — Postgres/PostGIS (raw parameterized SQL) for exact facts
  (finds, sources, places, feedback, runs). Anything fuzzy lives in per-agent
  markdown under `data/agents/<name>/` (profile.md is yours to edit too).
- **phoenix/** — Elixir/Phoenix service exposing the external read-only OSM
  places API at `api.localfinds.me` (`GET /osm/places`, bearer-token auth,
  reads the same materialized view; excludes locally-curated places).
- **data/** — ALL runtime state and personal config. Gitignored except
  `*.example` templates: keep PII out of git.

## Local development

Run the app and agents against a local Postgres/PostGIS seeded from live.

### First-time setup

1. `docker compose up -d` — starts PostGIS on `localhost:5434`.
2. `cp .env.local.example .env` and copy the same `LOCALFINDS_DATABASE_URL`
   into `apps/web/.env.local` (Next only auto-loads env from `apps/web`).
3. In another shell: `bash scripts/db-tunnel.sh` (opens the tunnel to live).
4. `npm run db:pull` — snapshots a live subset into `data/db/snapshots/`.
5. `npm run db:load` — rebuilds the local DB from the latest snapshot.
6. `npm run dev` (web) and/or `npm run agent <name> -- ...` (agents) — both
   now hit `localhost:5434`.

### Subsequent startups

Once `.env` and a local snapshot exist, each session just needs:

1. `docker compose up -d` — start PostGIS (skips if it's already up).
2. `bash scripts/db-tunnel.sh` — reopen the tunnel to live (needed to refresh
   dev data with `db:pull`/`db:load`).
3. `npm run dev` (web) and/or `npm run agent <name> -- ...` (agents).

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
npm run interview -- --depth=brief                      # interactive config interview (brief|medium|comprehensive; --prepared uses a filled questionnaire)
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

The app is served from a single host behind nginx (public reads; writes require
a steward login at `/auth/log-in` — Phoenix sessions checked via nginx
`auth_request`), reading the live Postgres database directly. Deploys run from this repo root on a clean tree — no sudo.
The real infra values (host, path, process name) live in the gitignored
`data/config/deploy.env`; the `deploy-localfinds` skill documents them.

```sh
npm run deploy                 # full: gate → deploy-code → migrate
npm run deploy -- --dry-run    # preview every remote action, change nothing
```

Composable stages: `deploy:gate` (blocks unless on `main`, tree clean, tests +
`tsc` pass), `deploy:code` (ships `main` via git — push to the box's bare repo,
then fetch + reset + clean in its checkout — rsyncs the gitignored config reals,
installs if the lockfile changed, builds), `deploy:migrate` (dumps the prod
Postgres DB, then applies pending `db/migrations/*.sql` via the tracked runner,
then reloads pm2 and verifies GET=200 / POST=401).

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
