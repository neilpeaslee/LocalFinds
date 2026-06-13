# LocalFinds

A single-user web app showing a curated feed of local finds — events, org
announcements, official notices — for one configurable region, gathered by
scheduled Claude agents that learn your taste from feed feedback.

- **apps/web** — Next.js feed UI (`/`), source registry (`/sources`), business
  directory (`/businesses`), agent profiles + run history (`/agents`).
- **packages/agents** — four Claude Agent SDK agents, run sequentially:
  **scout** (web-searches for new finds), **source-keeper** (maintains the
  source registry + per-site notes), **cartographer** (mirrors every business
  in the region from OpenStreetMap into the directory), **curator** (dedupes,
  prunes, expires, and keeps the taste profile).
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

## Running agents

```sh
npm run agent -- scout --max-turns 8         # cheap capped test run
npm run agent -- cartographer --max-turns 8  # populate /businesses from OpenStreetMap
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

## Resetting test data

The repo was verified against a stand-in region (Ann Arbor). To start fresh
with your real region:

```sh
rm -f data/localfinds.db*
rm -rf data/agents/*/notes data/agents/*/profile.md
npm run db:push
# region.md → your region; profiles re-bootstrap from *.example on next run
```
