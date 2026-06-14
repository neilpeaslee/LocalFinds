# Agents page run triggers — design

**Date:** 2026-06-14
**Status:** Approved (pending implementation plan)

## Goal

Let the user start agent runs directly from the Agents page (`/agents`) — a
single agent at a time, or the full roster in order — instead of only via the
CLI / cron. The page is display-only today.

## Selection model

Per-agent **Run** buttons plus one **Run all** button. This covers single-agent
runs ("in part") and the full sequence. Arbitrary subsets (e.g. scout + curator
only) are explicitly out of scope.

`Run all` runs the full roster in order: scout → source-keeper → cartographer →
curator (the existing `cli.ts all` order).

## Approach

Spawn the existing CLI as a **detached subprocess** from a Next server action.

When a Run button is clicked, a server action runs
`npx tsx packages/agents/src/cli.ts <agent|all>` detached, then returns
immediately. The CLI already calls `startRun`/`finishRun`, so a `running` row
appears in the DB instantly and the page's existing run-history table reflects
progress with **no new run-tracking code**.

This mirrors how `scripts/run-agents.sh` / cron already invoke the CLI, keeps the
web app decoupled (it depends only on `@localfinds/db`, not the agents SDK), and
is crash-resilient — the run row in the DB tells the story even if the web
process restarts.

### Alternatives rejected

- **Import `@localfinds/agents` and run inline in the web app.** Couples the web
  app to the heavy SDK and its env; a fire-and-forget promise inside a Next
  request is fragile (can be torn down with the request lifecycle). ✗
- **Job/queue table + separate worker process.** Robust but massive
  over-engineering for a local, single-user tool; needs a new always-on
  process. ✗

## Components

### 1. Server action — `apps/web/src/app/agents/actions.ts`

`triggerRun(target: string)`:

1. `resolveTarget(target)` — validate against the allowlist
   (`scout | source-keeper | cartographer | curator | all`). Reject anything
   else.
2. Concurrency guard — if `runInProgress(listRuns(...), now)` is true, refuse
   and return an "already in progress" result; do **not** spawn.
3. Spawn the CLI detached:
   `spawn("npx", ["tsx", "packages/agents/src/cli.ts", target], { cwd: repoRoot, detached: true, stdio: ["ignore", logFd, logFd] }).unref()`
   - `repoRoot` resolved via `findRepoRoot()` from `@localfinds/db`.
   - Output appended to `data/agents/web.log` with a timestamped marker so
     web-triggered runs are traceable separately from cron's `cron.log`.
   - Args passed as an array (no shell string) — combined with the allowlist,
     no command-injection surface.
4. `revalidatePath("/agents")`.

### 2. Pure helpers — in `@localfinds/db` (unit-tested)

Both helpers live in `@localfinds/db`, which already owns the `Run` type and
`listRuns` and has a vitest suite — so they get real unit tests without
bootstrapping a test runner in the web app. The web action and page import them.

- `runInProgress(runs, now)` → `boolean`. True only when a row has status
  `running` and `startedAt` is within the staleness window (20 min). False for:
  empty list, only-stale running row, all-terminal rows.
- `RUN_TARGETS` constant (`["scout", "source-keeper", "cartographer", "curator"]`)
  + `"all"`, and `resolveTarget(input)` → valid target or rejection. Encodes the
  allowlist. The web page imports `RUN_TARGETS` to render the per-agent sections,
  replacing the duplicated `AGENTS` constant currently in `page.tsx`.
  `cli.ts`'s own `rosterOrder` is left as-is (deduping it is out of scope).

### 3. UI — `apps/web/src/app/agents/page.tsx`

Stays a server component. Computes `runInProgress` once from the `listRuns`
result it already fetches, and:

- **Run all** button in the header (next to the 30-day spend), via
  `<form action={triggerRun.bind(null, "all")}>`.
- **Run** button in each agent `<section>` header next to the `<h2>`, via
  `<form action={triggerRun.bind(null, agent)}>`.
- While a run is in progress, all Run buttons render **disabled** with a small
  "run in progress…" note (UX reinforcement of the server-side guard).
- A stale `running` row (older than the window) is visually flagged
  ("running — likely crashed") in the existing status cell.

Buttons reuse the existing stone/Tailwind palette — no styling overhaul.

### 4. Live feedback — `AutoRefresh` client component

A small client component that calls `router.refresh()` on an interval (~4s),
mounted only when a run is in progress, so it stops polling once runs finish.
This is the only client-side code in the feature. It closes the gap where a
`running → success` transition wouldn't otherwise appear until a manual reload.

## Concurrency & staleness

Agents share the DB and per-agent profiles, and the roster is intentionally
sequential, so overlapping runs are disallowed. The guard refuses a new run
while a non-stale `running` row exists. A `running` row older than 20 min is
treated as crashed/stale: it no longer blocks new runs and is flagged in the UI.

**Accepted limitation:** during a `Run all`, there is a sub-second gap between
one agent's `finishRun` and the next agent's `startRun` where no row is
`running`. A second click in that exact window could start a second sequence.
For a single human clicking buttons this is negligible; tracking the subprocess
PID to close it is not worth the complexity.

## Testing

- **Unit (TDD):** in the `@localfinds/db` vitest suite — `runInProgress` (empty /
  non-stale running / stale running / all-terminal cases) and `resolveTarget`
  (each valid target accepted, invalid rejected). `spawn` itself stays out of
  unit tests — it's a thin side effect once the helpers are validated.
- **Manual:** `next dev`, click Run on one agent → confirm a `running` row
  appears and transitions to `success`; then Run all; then confirm the
  in-progress guard disables buttons and refuses a concurrent trigger.

## Out of scope

- Arbitrary agent subsets.
- Cancelling / killing an in-progress run from the UI.
- Streaming live agent output to the page (run history table is sufficient).
- Per-run cost confirmation dialog (the 30-day spend is already shown).
