# Handoff — 2026-06-21 — Scout cost tuning, fetch logging/blocking, capped status, iCal feeds

Session covered four related pieces of agent work, all now merged to `main` and validated with live agent runs.

## What was accomplished

### 1. Scout cost tuning (committed `394f8d6`)
- Diagnosed why scout runs were low-yield/expensive: at the default (high) reasoning effort, **output/thinking tokens dominated** the Sonnet bill and runs were hitting the $1 budget cap mid-work. Cost split observed: ~73% Sonnet (output + cache creation), ~27% Haiku (the SDK runs WebSearch/WebFetch extraction on Haiku 4.5).
- Set `scout` to `effort: "medium"` (was implicit high). Mirrors cartographer's `effort: "low"`. `packages/agents/src/agents/scout.ts`.

### 2. Capped run status (committed `9ee7a27` + `3fed22e`)
- A budget-capped run (`error_max_budget_usd`) is the **intended guardrail**, not a failure — the agent works until out of money and its saves are already persisted.
- Added a distinct `"capped"` run status: `statusFromResult()` in `run-agent.ts` maps the budget-cap subtype to `capped` (not `error`); `runs.status` enum + `run_end` event union gained `capped`; `lastSuccessfulRunStart` counts `success`+`capped` so the feedback cursor still advances; `/agents` UI renders capped amber (not red), no error logged/thrown.
- Backfilled 4 historical runs (11, 14, 26, 27) from `error`→`capped` via SQL.
- NOTE: the enum + `lastSuccessfulRunStart` parts landed inside the fetches commit `9ee7a27` (they were uncommitted in the tree when that branch began); the rest is in `3fed22e`. Cosmetic history quirk, not a correctness issue.

### 3. Scout fetch logging + host blocking (branch `feat/scout-fetch-logging`, merged)
Spec: `docs/superpowers/specs/2026-06-21-scout-fetch-logging-design.md`; plan: `docs/superpowers/plans/2026-06-21-scout-fetch-logging.md`.
- New `fetches` table (`packages/db/src/schema.ts`): one row per scout WebFetch — `run_id, agent, host, url, method, status, klass ('ok'|'blocked'|'truncated'|'error'), via, ts`.
- `classifyWebFetchResult` / `webFetchResultText` / `hostOf` — pure helpers in `packages/agents/src/web-fetch-log.ts` (the SDK flattens WebFetch results to text, so status is parsed from text, not structured).
- `blockedHosts(strikes=3)` (`queries.ts`): a host is hard-blocked after **3 consecutive 403/401** outcomes (newest-first by `id`; `ok`/`truncated`/`error` break the streak — 429/5xx/404 never strike).
- `makeWebFetchGuard()` PreToolUse hook (`path-guard.ts`) denies WebFetch to blocked hosts, model-independent; plus a "Hosts to skip" prompt note.
- `run-agent.ts` logs WebFetch outcomes in its message loop and installs the guard — **scout-only** (`isScout` gates both logging and blocking; `blockedHosts` has no agent filter, so non-scout rows must not be written — hence the gate). `clearFetchHistory(host)` is the manual un-block.

### 4. iCal feeds as a first-class source type (branch `feat/ical-feeds`, merged)
Spec: `docs/superpowers/specs/2026-06-21-ical-feeds-design.md`; plan: `docs/superpowers/plans/2026-06-21-ical-feeds.md`.
- Origin: user found owlshead.org (which 403s the agents' WebFetch) exposes a working iCal feed at `?ical=1` (it runs *The Events Calendar* / ECP). Verified: feed returns 200 + 30 VEVENTs at the same path whose HTML 403s.
- `packages/agents/src/ical.ts` (mirrors `overpass.ts`): hand-rolled RFC-5545 parser (`parseICal`, `isVCalendar`, `icalCandidates`) + `runIcalFetch` (browser-UA raw fetch, probes `?ical=1` candidates, injectable `fetchImpl`) + `formatIcalResult` (upcoming-only, sorted, capped, `isError`). No new npm dependency; no RRULE expansion.
- `sources.ical_url` column threaded through `upsertSource`.
- `fetch_ical` MCP tool + `ical_url` on `upsert_source`; granted to **both** scout and source-keeper.
- Prompts: source-keeper discovers feeds (probes via `fetch_ical`, records `ical_url`, **auto-activates** a feed-backed source — un-pauses owlshead); scout consumes `ical_url` sources via `fetch_ical` and saves events as finds (feed = venue's own primary source, satisfies the honesty rule).

### Live validation
- **source-keeper run #32**: discovered 4 feeds (owlshead, Farnsworth, Merryspring, Rockport Library), all set `active` with `ical_url`; marked Waldoboro library `dead` (3 consecutive failures). Its 6 "warnings" were healthy probe-misses (404 = venue has no feed).
- **scout run #33**: success, **10 finds, $0.84, 0 warnings, 0 WebFetch calls** — 9 finds came straight from the iCal feeds, including a previously-impossible **Owls Head** event. Yield jumped from the recent 1–4 finds to 10 at the same cost.

## Key decisions
- **Budget is the guardrail, not maxTurns** — capped is a normal outcome.
- **Fetch logging/blocking is scout-only** (deliberate scope). A future extension to source-keeper would mean dropping the `isScout` gate on logging and/or adding an `agent` filter to `blockedHosts`. source-keeper run #30 showed it hits the same blocks, so the data argues for it later.
- **iCal parser hand-rolled, no dependency**; **single tool with candidate auto-probing** (so source-keeper discovers feeds from just the site URL, even when HTML 403s); **auto-activate feed-backed sources**.
- **Dynamic filtering ruled out** — the API web_fetch dynamic-filtering feature needs the code-execution tool (the agents deliberately disallow it) and isn't exposed by the SDK WebFetch; prompt-driven extraction already captures the equivalent savings.
- `fetch_ical` is an MCP tool, so it is **not** subject to the WebFetch PreToolUse guard — a host hard-blocked for HTML remains usable via its feed.

## Important context for future sessions

### OUTSTANDING — do before the feature works in production
1. **Live/prod DB migration:** the live site (`localfinds.peaslee.org`, snapshot deploy via the gitignored `deploy-localfinds` skill) needs `npx drizzle-kit push` to create **both** `fetches` and `sources.ical_url`. Without it: WebFetch logging silently no-ops (the `recordFetch` try/catch swallows the error) AND **every** `upsert_source` throws `no such column: ical_url` (because `upsertSource` always writes the column). This exact failure happened locally — see run #31.
2. **Push to origin:** `main` is ~24+ commits ahead of `origin/main` — nothing has been pushed this session (all merges were local per user choice). `origin` = github.com/neilpeaslee/LocalFinds (public).

### Gotchas learned
- **`npm test` (vitest/esbuild) does NOT typecheck.** A merge introduced a tsc-only error in `apps/web/src/lib/sources.test.ts` (Source fixture missing the new `icalUrl` field) that all 218 vitest tests passed over. Fixed in the merge commit `ce03fdf`. **Run `tsc --noEmit` (all 3 packages) as part of finishing a branch**, not just `npm test`.
- **schema changes need `drizzle-kit push`** on any real DB (`packages/db/src/client.ts` only opens the file + sets pragmas — no CREATE/migrate on open). Tests handle it in `beforeAll`; dev/prod do not.
- **Run #31 lesson:** a run where every core tool call fails can still report `status: success` (the SDK "didn't crash" notion). The **warnings count** is the real signal — run #31 was `success` with 14 warnings and 0 items written (DB wasn't migrated). Glance at warnings, not just status.
- A failed **iCal probe** (404 = "no feed here") surfaces as a run **warning** because `fetch_ical` returns `isError:true` on any non-feed response (mirrors `overpass_query`). For discovery this slightly over-reports; a future refinement could distinguish "probe miss" from "real fetch error." Not urgent.

### Data / branch status
- Both feature branches merged into `main` and deleted. Only `main` remains.
- Agents run via `cd packages/agents && npx tsx src/cli.ts <scout|source-keeper|cartographer|curator|all>` (loads `.env`; needs `ANTHROPIC_API_KEY` + `data/config/region.md`, both present locally). Region = Rockland/Knox County, Maine.
- Runtime data (DB at `data/localfinds.db`, run logs under `data/agents/<agent>/runs/`) is gitignored (PII boundary). Local DB now has both schema updates applied.
- SDD scratch (ledgers, task briefs/reports) under `.superpowers/sdd/` is gitignored.
- Owls Head WebFetch fetch-log still shows 2 `blocked` strikes (from run #29, pre-feed). It will not reach the 3rd strike now that scout uses the feed instead — and that's fine; if it ever does, `clearFetchHistory("owlshead.org")` clears it.
