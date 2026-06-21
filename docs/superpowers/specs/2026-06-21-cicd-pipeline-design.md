# Design — 2026-06-21 — Local CI/CD pipeline (code, schema, content)

A repeatable, safe pipeline for shipping LocalFinds to `localfinds.peaslee.org`
(the `udl` EC2 box). Replaces the ad-hoc commands in the gitignored
`deploy-localfinds` skill with committed, infra-agnostic scripts. Covers three
flows that behave very differently:

- **Code** — flows through git → committed tree rsynced to the server.
- **Schema** — moves from interactive `drizzle-kit push` to committed, ordered
  migration files applied non-interactively.
- **Content** — agent-generated discovery data, gitignored (PII boundary, public
  repo), shipped as a SQLite snapshot and **merged** into prod so prod-side user
  activity (feedback, stars, hides) is never clobbered.

## Decisions (settled in brainstorming)

1. **Local scripted pipeline**, not cloud CI/CD. Fits the no-secrets-in-cloud,
   PII-gitignored, deliberately-local-only model. No GitHub Actions, no SSH key
   in a cloud runner.
2. **Versioned migrations** (`drizzle-kit generate` + `migrate`), not `push`.
3. **Content sync = merge** preserving prod activity, not snapshot clobber.
4. **One orchestrator + composable parts** — a single `deploy` plus per-stage
   commands.
5. **Committed infra-agnostic scripts + gitignored config** — public repo shows
   the pipeline logic, never the infra (IP, host, paths).

## Architecture

A single orchestrator runs four stages in order; each stage is independently
runnable. Root `package.json` exposes them as npm scripts; the implementations
live in `scripts/deploy/*.sh`.

```
npm run deploy              # gate → migrate → deploy-code → sync-content
npm run deploy:gate
npm run deploy:migrate
npm run deploy:code
npm run deploy:sync-content
```

The gitignored `deploy-localfinds` skill is updated to *invoke* these scripts;
its infra facts table (host, paths, nginx, auth) stays in the skill.

### Layout

```
scripts/deploy/
  lib.sh             # load config, ssh helper, nvm-prefix helper, remote backup
  gate.sh            # tests + tsc + clean-tree/on-main checks
  migrate.sh         # apply pending migrations to prod; keep local current
  deploy-code.sh     # rsync committed tree → npm ci/build → pm2 reload
  sync-content.sh    # snapshot → ship → tsx merge on prod → pm2 reload
  deploy.sh          # orchestrator: gate → migrate → deploy-code → sync-content

data/config/
  deploy.env         # GITIGNORED — DEPLOY_HOST, DEPLOY_PATH, remote db path, nvm prefix
  deploy.env.example # COMMITTED — documents the shape, no real values

packages/db/
  drizzle.config.ts  # gains out: "./drizzle"
  drizzle/           # COMMITTED migration files (0000_*.sql baseline, then onward)
  src/sync-merge.ts  # the merge routine (testable)
  src/sync-merge.test.ts
```

### Config (`data/config/deploy.env`)

Gitignored (inside the existing `data/**` boundary). Holds everything
infra-specific so committed scripts stay public-safe:

| Var | Example | Purpose |
|---|---|---|
| `DEPLOY_HOST` | `udl` | SSH alias (resolves to IP via local `~/.ssh/config`) |
| `DEPLOY_PATH` | `/var/www/localfinds` | App dir on the server |
| `DEPLOY_DB` | `data/localfinds.db` | DB path relative to `DEPLOY_PATH` on prod |
| `DEPLOY_NVM_PREFIX` | `export NVM_DIR=$HOME/.nvm; . $NVM_DIR/nvm.sh;` | prepended to every remote node/npm/pm2 cmd |
| `DEPLOY_PM2_NAME` | `localfinds` | pm2 process name |

`lib.sh` sources this file and fails loudly with a pointer to `.example` if it's
missing.

## Stage 1 — Gate (`gate.sh`)

Blocks the deploy unless every check passes. No deploy proceeds on a red gate.

- **Tests:** `npm test` (db + agents + web vitest suites).
- **Typecheck:** `tsc --noEmit` for all three packages. This is the run-#31
  lesson — vitest/esbuild does not typecheck, so a tsc-only error (e.g. a
  fixture missing a new column) passes all tests but breaks the build. Both
  gates are mandatory.
- **Clean tree + on `main`:** `deploy-code` rsyncs `git ls-files` only, so any
  uncommitted/unstaged change would silently *not* ship. The gate aborts if
  `git status --porcelain` is non-empty or the current branch is not `main`.

`gate.sh` runs purely locally (no SSH). It is the first stage of `deploy` and a
standalone `deploy:gate`.

## Stage 2 — Migrate (`migrate.sh`)

Replaces `drizzle-kit push` with ordered, committed migrations.

### One-time switch (adoption on existing DBs)

The **local DB** already carries today's full schema (applied with `push`). The
**prod DB is one change behind** — it never received the `fetches` table or the
`sources.ical_url` column (the standing handoff item; `push` was deliberately
not run on prod). The two DBs are therefore at different points, and adoption
must account for that.

A freshly-generated baseline `0000` captures the *current* full schema, so
naively running it against either existing DB would `CREATE TABLE` over existing
tables and fail. The switch instead converges prod, then *adopts* migrations on
both DBs rather than replaying them:

1. Add `out: "./drizzle"` to `drizzle.config.ts`.
2. `drizzle-kit generate` → produces `drizzle/0000_<name>.sql` capturing the
   current schema. Commit it (and `drizzle/meta/`).
3. **Converge prod to the current schema** with a final one-time
   `drizzle-kit push` against the prod DB (additive: creates `fetches`, adds
   `sources.ical_url`; existing data intact — this is exactly the outstanding
   handoff step). After this, prod and local schemas match `0000`. This is the
   last `push` ever run.
4. **Baseline-mark** `0000` as already-applied on **both** DBs by seeding
   drizzle's `__drizzle_migrations` table with `0000`'s hash, *without* running
   the SQL. A small one-time `tsx` adoption script does this idempotently
   (no-op if the row already exists).
5. From then on, `migrate` only runs migrations newer than the recorded
   baseline.

This adoption sequence runs once; it is documented in the plan and the adoption
script is kept for reference but not part of the recurring pipeline.

### Recurring behavior

- A schema change is made by editing `schema.ts`, running `drizzle-kit generate`
  (new `NNNN_*.sql`), reviewing + committing it.
- `migrate.sh` takes a **timestamped `.backup` of the prod DB** first (rollback
  insurance), then runs `drizzle-kit migrate` non-interactively against prod
  over SSH (nvm prefix), and also ensures the local DB is migrated so dev and
  prod schemas stay in lockstep. No interactive prompt, no column drop/recreate
  guesswork.

## Stage 3 — Deploy code (`deploy-code.sh`)

Mechanically equivalent to today's skill `redeploy` code step, parameterized by
config:

1. `rsync -az --files-from=<(git ls-files) ./ $DEPLOY_HOST:$DEPLOY_PATH/` —
   ships the committed tree only (excludes `node_modules`, `.next`, `.git`,
   `data`, `.env`, gitignored deploy docs).
2. On the server (nvm prefix): `npm ci` (skip when `package-lock.json`
   unchanged — detected by comparing local vs remote hash), `npm run build -w
   @localfinds/web`, `pm2 reload $DEPLOY_PM2_NAME`, `pm2 save`.
3. Verify: `GET /` → 200, `POST /` → 401 (auth gate intact).

## Stage 4 — Sync content (`sync-content.sh` + `packages/db/src/sync-merge.ts`)

The one stage with real logic. Local is authoritative for **discovery** data;
prod is authoritative for **user activity**.

### Mechanism

1. Local: `sqlite3 data/localfinds.db ".backup '/tmp/localfinds-sync.db'"` — a
   consistent snapshot (no WAL tearing).
2. `rsync` the snapshot to a temp path on prod (e.g.
   `$DEPLOY_PATH/data/.sync-incoming.db`).
3. On prod (nvm prefix): take a timestamped `.backup` of the live DB, then run
   `tsx packages/db/src/sync-merge.ts <incoming> <prod-db>`.
4. `pm2 reload $DEPLOY_PM2_NAME`; remove the incoming temp file.

### `sync-merge.ts` semantics

Opens the prod DB (better-sqlite3), `ATTACH`es the incoming snapshot, runs one
transaction:

| Table | Conflict key | On conflict |
|---|---|---|
| `sources` | `url` | update all columns |
| `businesses` | `osm_id` | update all columns |
| `finds` | `url_hash` | update **content columns only** (`title`, `url`, `summary`, `event_*`, `expires_at`, `published_at`, `tags`, `score`, `source_id`, `agent`) — **never** `status` |
| `runs` | `id` | insert if absent (prod never writes runs) |
| `fetches` | `id` | insert if absent |
| `feedback` | — | **never touched** (prod-only) |

- New `finds` insert with their default `status` (`new`); existing finds keep
  whatever status prod set (starred/hidden/shown).
- Wrapped in a single transaction → atomic; a failure leaves prod untouched
  (and the pre-sync `.backup` is the belt-and-suspenders rollback).
- **Known limitation:** deletions do not propagate — a find/source removed
  locally remains on prod. Acceptable for now (YAGNI). A future `--prune` could
  delete prod rows absent from the snapshot, gated to never remove rows with
  user activity.

## Stage orchestration (`deploy.sh`)

Runs `gate → migrate → deploy-code → sync-content`, aborting on the first
failure. A `--dry-run` flag prints the actions (rsync targets, remote commands)
without executing remote mutations — the smoke-test path for the shell glue.

## Testing

- **`sync-merge.test.ts` (primary):** build a "prod" temp DB containing a
  `feedback` row and a find marked `starred` and one `hidden`; build a "local"
  snapshot DB with a brand-new find, an edited existing find (new summary/score,
  but caller hasn't changed status), and a new source. Run `sync-merge`, assert:
  prod feedback row intact; starred/hidden statuses preserved; new find present
  with `status='new'`; edited find's content updated; new source present. This
  is the highest-value test — the merge is the only piece with branching logic.
- **Migration test:** applying all committed migrations to a fresh DB yields a
  schema matching `schema.ts` (e.g. compare table/column introspection, or
  assert a representative insert/select round-trips on every table).
- **Shell glue:** covered by `deploy.sh --dry-run`; no unit tests for rsync/ssh
  wrappers.

## Out of scope (YAGNI)

- Cloud CI/CD (GitHub Actions) — explicitly rejected.
- Live agents/cron on the server (still Phase 2 of the deploy design).
- Delete propagation in content sync.
- Two-way sync (pulling prod activity back to local) — prod activity stays on
  prod; local never needs it.

## Relationship to existing work

- Updates the gitignored `deploy-localfinds` skill to call these scripts; infra
  facts table stays there.
- Resolves the standing handoff item "prod needs `drizzle-kit push` for
  `fetches` + `sources.ical_url`" — that push happens once during adoption
  (step 3) to converge prod to the `0000` baseline, after which schema changes
  flow through committed migrations and the `migrate` stage.
- The deliberate "main is N commits ahead of origin, unpushed" state is
  unaffected; this pipeline deploys from the local committed tree and does not
  require pushing to `origin` (though committing migration files is required, as
  always).
