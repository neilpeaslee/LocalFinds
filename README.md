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
- Overpass API
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

- **apps/web** — Next.js feed UI (`/`), source registry (`/sources`), business
  directory (`/businesses`), agent profiles + run history (`/agents`).
- **packages/agents** — five Claude Agent SDK agents, run sequentially:
  **scout** (web-searches for new finds), **source-keeper** (maintains the
  source registry + per-site notes), **cartographer** (mirrors every business
  in the region from OpenStreetMap into the directory), **prospector**
  (discovery-only local B2B lead-gen — qualifies the directory against an Ideal
  Customer Profile and saves matches as `lead`-type finds), **curator**
  (dedupes, prunes, expires, and keeps the taste profile). Finds carry a
  free-text `type` (`event` by default, `lead`, …); the feed shows all types and
  `/feed?type=lead` narrows it.
- **packages/db** — Drizzle + SQLite for exact facts (finds, sources,
  businesses, feedback, runs). Anything fuzzy lives in per-agent markdown under
  `data/agents/<name>/` (profile.md is yours to edit too).
- **data/** — ALL runtime state and personal config. Gitignored except
  `*.example` templates: keep PII out of git.

## Setup

```sh
npm install
cp .env.example .env                                  # add ANTHROPIC_API_KEY
cp data/config/region.md.example data/config/region.md   # describe YOUR region
npm run db:push && npm run db:seed
npm run dev                                           # http://localhost:3000
```

The schema is applied from the canonical SQL migrations in `db/migrations/*.sql`.
After pulling changes that add a new migration, re-run `npm run db:migrate` to
apply them to your existing database.

## Running agents

```sh
npm run agent -- scout --max-turns 8         # cheap capped test run
npm run agent -- cartographer --max-turns 8  # populate /businesses from OpenStreetMap
npm run agent -- prospector --max-turns 8    # qualify the directory into leads (needs an ICP profile)
npm run agents:all                           # full roster, sequential
npm test                                     # vitest (db package)
npm run db:studio                            # inspect the database
```

The cartographer pulls businesses from OpenStreetMap via the Overpass API (no
API key needed) and walks a (town × business-key) grid using
`data/agents/cartographer/notes/coverage.md` as its cursor, so coverage builds
up incrementally across runs.

Schedule with cron once region + API key are real (see the comment in
`scripts/run-agents.sh`):

```
0 7,12,18 * * * /home/neil/Projects/LocalFinds/scripts/run-agents.sh
```

Budget guardrails: per-agent `maxTurns`, `maxBudgetUsd` ($1/run default),
prompt-level search caps. Per-run cost is logged to the `runs` table and
totaled on `/agents`.

Watch a run live — or read any past run's full transcript — on `/agents`: each
run streams a structured event log to `data/agents/<agent>/runs/<id>.jsonl`,
surfaced via Server-Sent Events and a per-run detail page (`/agents/runs/<id>`).

## Deploy

The app is served as a snapshot from a single host behind nginx (public reads,
auth-gated writes). Deploys run from this repo root on a clean tree — no sudo.
The real infra values (host, path, process name) live in the gitignored
`data/config/deploy.env`; the `deploy-localfinds` skill documents them.

```sh
npm run deploy                 # full: gate → migrate → deploy-code → sync-content
npm run deploy -- --dry-run    # preview every remote action, change nothing
npm run deploy:sync-content    # data only — refresh content after an agent run
```

Composable stages: `deploy:gate` (blocks unless on `main`, tree clean, tests +
`tsc` pass), `deploy:migrate` (applies new Drizzle migrations, prod DB backed up
first), `deploy:code` (rsyncs the tree, builds, reloads, verifies GET=200 /
POST=401), `deploy:sync-content`.

`sync-content` merges local discovery data into the prod DB **preserving
prod-side activity** — the `feedback` table and `finds.status` (stars/hides/shown)
are never overwritten — then ships agent runtime files and reloads. The prod DB
is backed up first; deletes do **not** propagate (a find removed locally stays on
prod). After it finishes, sanity-check the site:

```sh
curl -s -o /dev/null -w "%{http_code}\n" https://localfinds.peaslee.org/        # 200
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://localfinds.peaslee.org/ # 401
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
