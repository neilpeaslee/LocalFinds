# Handoff — Interview depth/refine cycle shipped + merged; private data repo; PostGIS spec refresh

_Date: 2026-06-27 · Branches: shipped on `feat/interviewer-agent` → **merged to `main`** (deleted); now on `feat/postgis-osm-api`. Session: designed/planned/built the depth-dialled interviewer cycle, drove the live smoke, merged + pushed it public, stood up a private `data/` git repo + a db backup route, fixed the deploy content-sync, and refreshed the PostGIS spec against the live `udl` box._

## What was accomplished

### 1. Interview **depth dial + refine cycle** — built, smoke-tested, merged

Turned the interviewer's fixed two-phase flow into a depth-dialled **`convo → build → run → review`** loop. Plan: `docs/plans/2026-06-25-interview-depth-refine-cycle.md` (committed). Executed **11 TDD tasks via subagent-driven-development** + a whole-branch review; full task-by-task record in `.superpowers/sdd/progress.md` (gitignored).

- **Depth dial** (`--depth=brief|medium|comprehensive` → `preliminaryCycles` 0/1/2; default brief). Total cycles = `preliminaryCycles + 1`; final cycle uses high-effort build+review, preliminary cycles low.
- **Cycle phases:** `convo` (live `ask_user`), `build` (synthesis → **staging dir**), `run` (small capped prospector pass, `maxTurns 8`/`effort low`, leads tagged **provisional** in the real DB), `review` (read-only: report + `probes` that seed the next `convo`).
- **Isolation (hybrid, locked):** config + ICP write to a scratch staging dir (`data/.staging-<runId>/`) via a new `configDir()` override; leads go to the **real DB** with `status:"provisional"`, excluded from every user-facing view until promoted. The **DB path stays on `dataDir()`** (never moved by the override). On confirm → promote staging + flip provisional→new; on reject/failure → discard staging + delete provisional; provisional cleared per-cycle.
- **Prospector near-miss prompt** (`prospector.ts` step 7) — the linchpin: it must log what it *skipped* so `review` can catch false-negatives.
- Key files: `packages/db/src/{schema.ts,queries.ts,paths.ts,config.ts}` (provisional status + helpers, `configDir` override); `packages/agents/src/{run-agent.ts,mcp-tools.ts,interview-staging.ts,interview.ts,interview-tools.ts,agents/interviewer.ts,agents/prospector.ts}`.
- **Final whole-branch review (opus)** verdict "with fixes" — all 5 invariants held; one real cross-task bug fixed: **`runReview` now wraps `setConfigDirOverride(staging)`** so the review reads the *staged* ICP, not the pre-interview config (plus `listRecentFinds` excludes provisional; test env restore).

### 2. Live smoke (Task 10 Step 6) — **passed**, after two interactivity fixes it surfaced

- **Run 1 reproduced a bug:** the collection agent posed questions via the non-blocking `say` tool and ended its turn without waiting, then wrote config from invented "unanswered" assumptions.
  - **Fix `c51138f`:** removed `say` from `COLLECTION_TOOLS` (structural — `ask_user`, which blocks, is now the only channel) + firmer prompt (never assume/skip; interview even on a refine) + framed input (rule above/below).
- **Run 2 passed end-to-end** including the **accept/promote path** (ICP written, 2 leads promoted to `new`, transcript archived). An earlier reject run validated cleanup (0 provisional, config untouched, no `.staging-*` left).
- **Paste fix `29f9aad`:** pasted multi-line editor text was submitting each line as a separate answer. `readMultilineAnswer` now accumulates lines until a **blank line** (unit-tested). Prompt: "paste freely — Enter on a blank line to send."

### 3. Merged + shipped

`feat/interviewer-agent` **fast-forward merged to `main`** (`91d8482`), full suite green on the result (**db 147 / agents 103 / web 51**), **pushed to GitHub + Henry**, feature branch **deleted**. README **"Deploy" section** committed (`91d8482`).

### 4. Private `data/` git repo (versioning the gitignored content)

`data/` is now its **own nested git repo** (`data/.git`, branch `main`), invisible to the public repo. One `origin` that fetches from **gitudl** and pushes to **both gitudl + Henry**:
- `gitudl:repos/localfinds-data.git` (bare repo on `udl`, git user)
- `ssh://henry/srv/data/git/localfinds-data.git`
- Tracks agent `profile.md`s, real `config/`, `notes/**`, `runs/*.jsonl`. **Excludes** (`data/.gitignore`): `localfinds.db*`, `config/deploy.env`, `*.example`, `.staging-*/`.
- Snapshotted the accepted-interview ICP change at `1b6e58f` (pushed to both).
- Memory written: `localfinds-private-data-repo.md`.

### 5. Backup + deploy hygiene

- **DB backup route** (second orthogonal route; db is excluded from the git repo): consistent `sqlite3 .backup` → `henry:/srv/data/localfinds-backups/` (2 snapshots there; `/srv/data/backups` is ftpadmin-owned, so used a neil-owned dir).
- **`scripts/deploy/sync-content.sh`** (`755ed7c`): the `data/` rsync now **excludes `.git`, `.gitignore`, `.staging-*`** so the nested repo never ships to prod. Verified by itemized dry-run (95 content entries still ship).

### 6. PostGIS OSM-API spec refreshed against the live `udl` baseline (`b5b17c8`)

`docs/superpowers/specs/2026-06-25-localfinds-postgis-osm-api-design.md` updated from `~/Projects/cm/udl`'s 2026-06-27 inventory (see Key decisions).

## Key decisions

- **Hybrid isolation** chosen over a full staging data-dir: config→staging dir, leads→real DB w/ `provisional` status. Avoids a second DB to merge; the `configDir()` override moves only the 4 interviewer artifacts, never `dbPath()`.
- **Run source = today's local DB** (`list_businesses`); the bespoke PostGIS API is a later drop-in at that tool — the interview cycle is unchanged by the swap.
- **Collection waiting is structural, not just prompted:** removing `say` leaves the agent no non-blocking channel, so it cannot narrate-and-bail. Preferred over relying on prompt wording alone.
- **Multi-line input = accumulate-until-blank-line** (readline), not a raw-mode bracketed-paste editor. Low-risk, testable, solves the reported case. **Caveat:** a blank line *within* pasted prose ends the answer early; true raw-mode textarea (Shift+Enter) is a deferred follow-up.
- **Plan bug caught during execution:** the plan said to delete `snapshot`/`restore`/`reviewAndConfirm`/`targetConfigFiles`/`TargetFile`, but `runPrepared` (the questionnaire path, intentionally untouched) still uses all of them — they were **retained** (deleting would break compilation).
- **Coverage.md is NOT promoted** from the sample run (it walks a tiny slice; promoting its cursor would make the scheduled prospector skip towns). Only region/towns/categories/profile promote.
- **Cross-cycle crash resume is out of scope** (a crash leaves an ignorable `.staging-*`; a new runId makes a fresh one).
- **PostGIS spec:** PostGIS installs into the **existing shared PG15 cluster** (pgvector co-tenant already present) — isolate the `gis` DB/role, throttle the import so it doesn't starve co-tenants. **EBS resize 15→30 G is the hard first prereq** (root 15 G @ 77%, ~3.4 G free). Adopted `udl`'s execution model: Claude read-only + drafts runbooks, **Neil runs every `sudo`**; concrete values (IP/ports/token/bind) stay in `cm/udl` + the gitignored deploy skill, never the public repo.

## Important context for future sessions

- **Branch status:** on `feat/postgis-osm-api`, **2 commits ahead of `main`** (`352a571` design + `b5b17c8` refresh), rebased onto the post-merge `main` (current with everything). `main` is public (GitHub + Henry) and holds the shipped interviewer cycle. `feat/interviewer-agent` is deleted.
- **Working tree:** one untracked predecessor handoff (`docs/handoff/2026-06-23-001-...md`) carried along; not yours to touch.
- **Data locations:**
  - Private content repo: `data/.git` → `gitudl:repos/localfinds-data.git` + `ssh://henry/srv/data/git/localfinds-data.git` (tip `1b6e58f`). Use `git -C data ...`. **Snapshot `data/` before any interview that may overwrite `profile.md`.**
  - DB backups: `henry:/srv/data/localfinds-backups/localfinds-<ts>.db`. Refresh: `sqlite3 data/localfinds.db ".backup '/tmp/x.db'"` then `rsync -az /tmp/x.db henry:/srv/data/localfinds-backups/`.
  - SDD ledger (gitignored scratch): `.superpowers/sdd/progress.md` — full per-task record incl. deferred Minors.
- **Deferred Minor findings** (not blocking; for a future cleanup pass): `listProvisionalFinds` `as Find[]` cast; `resolveFindStatus` is a plan-mandated identity passthrough; no unit test for `ensureWorkspace`'s `.example`-copy branch; staging test doesn't assert `notes/` pre-created; `interview-tools.test.ts` `beforeAll` mutates `LOCALFINDS_DATA_DIR` (added `afterAll` restore in the final-review fix wave — confirm).
- **Interviewer behavior to know:** the prospector sample run's transcript (`runs/<n>.jsonl`) + its DB `runs` row persist even on a **rejected** interview (real run history, harmless). The interviewer journal is cleared between runs.
- **Test commands:** `npm test` (all 3 pkgs). Per package: `npm -w @localfinds/{db,agents,web} run test`. **vitest does NOT typecheck** — always `cd packages/<x> && npx tsc --noEmit` after edits (this bit us once: a `TS2440` slipped past green vitest). Repo has **no ESLint**; tsc is the only static gate.
- **PostGIS — next steps:** write an implementation plan from the refreshed spec. **Track A (infra: EBS resize → PostGIS install → Maine import → replication cron)** = supervised runbooks that belong in `~/Projects/cm/udl` (Neil runs sudo; Claude verifies read-only). **Tracks B/C (the `services/osm-api/` FastAPI service + the cartographer `osm_query` tool replacing `overpass.ts`)** = buildable/testable here against Docker PostGIS + stubs. Resize FIRST; throttle the import.
- **`~/Projects/cm/udl`** is the box's CM workspace (origin gitudl, mirror Henry) — read its `inventory/2026-06-27-{baseline,postchange}.md` for live host facts. The box hostname is finalized `was` → `udl` (SSH aliases `udl`/`was` both resolve; `gitudl` for git).
