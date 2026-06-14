# Agent run streams and logs — design

**Date:** 2026-06-14
**Status:** Approved (pending implementation plan)

## Goal

Watch an agent run **live** in the web UI as it works, and **read a finished run
deeply** afterward — the full transcript of what each agent did, where its turns,
cost, and time went, and what errored. This is the "Streaming live agent output
to the page" item the [run-triggers spec](2026-06-14-agents-page-run-triggers-design.md)
explicitly deferred.

Two jobs, one artifact:

- **Live stream** — a curated, readable activity feed that updates in real time
  while a run is in progress, with each event expandable to its full payload.
- **Per-run analysis** — open any (post-feature) run and see its complete
  transcript plus summary stats.

Cross-run analytics (cost trends, tool-usage frequency, error rates over time)
is **out of scope** — see below.

## Approach

The runner already iterates the Agent SDK message stream (`query()` in
`run-agent.ts`); today `logMessage()` collapses it to truncated `console.log`
text and discards the structure. Instead, project each SDK message to a
structured JSON line and append it to a **per-run event log**:

```
data/agents/<agent>/runs/<runId>.jsonl    # one JSON event per line
```

That single file serves both jobs:

- **Live** → an SSE endpoint tails the file and pushes each new line to the
  browser as it is written.
- **Analysis** → the same file is the persisted, replayable transcript.

It fits the project's storage split — bulky semi-structured transcripts live in
gitignored `data/` (PII stays out of git; `data/**` is already ignored), while
exact stats stay in the `runs` table. Transport is **SSE, not websockets**: the
flow is one-way (agent writes, browser reads), `EventSource` auto-reconnects,
and it is native to Next route handlers. Producer (the detached CLI subprocess)
and consumer (the Next server) stay decoupled — they share only the filesystem,
exactly as they do today.

### Alternatives rejected

- **Tail the existing `data/agents/web.log`.** Minimal (no producer changes),
  but it interleaves every run as lossy, unstructured text — no per-run
  separation, no full payloads. Fails both "read one run deeply" and
  "expand to full." ✗
- **`run_events` table in SQLite.** Queryable across runs, but it pushes bulky
  transcript text into the exact-facts DB (against the storage principle), adds
  concurrent-writer pressure from the detached child while the web reads, and
  the live tail becomes DB polling. Cross-run analytics is deferred anyway, so
  this buys nothing now. It is an **additive** future step (the runner can also
  insert events) once the project moves to Postgres — not a rewrite. ✗

## Event model

One discriminated-union event per line. Each carries `seq` (monotonic per run)
and `t` (ISO timestamp). Full payloads are stored; the UI curates at render time
so "expand to full" is a pure render toggle, never a re-fetch.

| `kind` | Projected from | Key fields |
| --- | --- | --- |
| `run_start` | first emit, after `startRun` | `agent`, `runId`, `model`, `maxTurns` |
| `assistant_text` | assistant message, `text` block | `text` |
| `tool_use` | assistant message, `tool_use` block | `id`, `name`, `input` (**full**) |
| `tool_result` | **user** message, `tool_result` block | `toolUseId`, `content` (full), `isError` |
| `result` | `SDKResultMessage` | `subtype`, `numTurns`, `costUsd`, `usage`, `permissionDenials` |
| `error` | catch block | `message` |
| `run_end` | finally | `status` (`success` \| `error`) |

Note: `tool_result` blocks arrive on **user**-type messages in the SDK stream —
which the current `logMessage()` ignores. Capturing them is what makes the
transcript show what each tool actually returned. The implementer should confirm
the exact block shape against the installed SDK version.

## Components

### 1. Event log writer — `packages/agents`

New module `run-log.ts`:

- `openRunLog(agent, runId)` → a writer with `write(event)` and `close()`.
  Resolves the path via the shared `runLogPath` helper, `mkdir -p`s the `runs/`
  dir, opens an append fd, and assigns `seq`/`t`.
- A pure `projectMessage(message): RunEvent | null` that maps one SDK message to
  an event (or `null` to skip). This is the unit-tested core.

Wired into `run-agent.ts`: open the log right after `startRun(runId)`; in the
existing `for await` loop, `projectMessage` each message and `write` non-null
results; write `result` / `error` / `run_end` in the existing finish/catch
paths; `close` at the end. The brief `console.log` stays so `cron.log` keeps
working unchanged.

### 2. Shared seam — `@localfinds/db`

Single source of truth so the writer and both readers agree:

- `runLogPath(agent, runId)` → absolute path under `data/agents/<agent>/runs/`.
- `getRun(runId)` → the `Run` row (agent name + status for the readers).
- `readRunEvents(agent, runId)` → `RunEvent[]` (parse the JSONL; tolerate a
  trailing partial line from an in-flight write).

These live in `@localfinds/db` (which already owns `Run`, `listRuns`,
`findRepoRoot`, `agentWorkspaceDir`, and a vitest suite).

### 3. Live path — SSE route handler

`apps/web/src/app/api/runs/[runId]/stream/route.ts` returns a
`text/event-stream` `ReadableStream`:

1. `getRun(runId)` → agent name → `runLogPath`.
2. **Catch-up:** read the file so far, emit each complete line as an SSE event.
3. **Tail:** poll the file by byte offset (~500ms–1s). On growth, read
   `[offset, size)`, append to a buffer, split on `\n`, emit complete lines, keep
   the remainder. (Offset polling over `fs.watch` — robust to partial writes and
   dev/turbopack quirks; run events are low-frequency, so the cadence is ample.)
4. **Close** on: a `run_end` event emitted, OR the run row is no longer `running`
   and EOF is reached, OR client disconnect (`request.signal` abort). Clear the
   interval on every exit path.

The tail/offset line-splitting is a pure function (`splitLines(buffer, chunk)`),
unit-tested.

### 4. Live + analysis UI — one `RunTranscript` component

`apps/web/src/components/RunTranscript.tsx` (client). Renders the curated feed
— one row per event (icon by `kind` + a one-line brief), each row expandable to
its full JSON payload. Fed `initialEvents` as props; if `live` is set, it opens
an `EventSource` on `/api/runs/<runId>/stream` to append the rest, auto-scrolls,
and on `run_end` calls `router.refresh()` once (to update the summary table) and
closes the stream. **Two entry points, same component:**

- `/agents` mounts it `live` for the in-progress run (no `initialEvents` needed
  beyond catch-up, which the SSE endpoint replays).
- The run detail page (below) passes the full `readRunEvents` result as
  `initialEvents`, and sets `live` only if the run is still `running`.

### 5. Run detail page — `apps/web/src/app/agents/runs/[runId]/page.tsx`

Server component: `getRun(runId)` + `readRunEvents(agent, runId)` →

- a stats header (agent, status, turns, cost, duration, items added/updated,
  error if any), and
- `<RunTranscript initialEvents={events} live={run.status === "running"} runId={runId} />`.

Run-history rows on `/agents` link here.

### 6. Wire-in & cleanup — `apps/web/src/app/agents/page.tsx`

- Mount `RunTranscript` (live) for the active run, replacing the blind 4s
  `AutoRefresh` page-poll. `RunTranscript` already triggers a single
  `router.refresh()` on `run_end`, so the summary table still updates — with less
  polling and a more responsive transition. `AutoRefresh.tsx` is removed.
- Link each run-history row to `/agents/runs/<runId>`.

## Robustness

- **Agent name is resolved from the `runs` row**, not the URL, so the path is
  always correct for a given `runId`.
- **Cold-start gap:** the detached `npx tsx` child takes ~10s to register its
  `running` row and write the first event (noted in the existing
  `triggerRun`). The live view renders a "starting…" state until `run_start`
  arrives; the SSE endpoint tolerates a not-yet-existent file (treat as empty,
  keep polling until the row leaves `running`).
- **Crash:** if the child dies, no `run_end` is written. The SSE endpoint closes
  when the run row is no longer `running` and EOF is reached, so the stream still
  terminates cleanly; the detail page shows the (stale/error) row status.

## Testing

- **Unit (TDD), in the existing vitest suites:**
  - `projectMessage` — each SDK message kind → expected event (and skips).
  - `splitLines` — buffering across chunk boundaries, partial trailing line,
    multiple lines per chunk, CRLF tolerance.
  - `readRunEvents` — parses a fixture JSONL; tolerates a trailing partial line.
- **Manual:** `next dev`, trigger a run, confirm the live feed streams events and
  rows expand to full payloads; let it finish and confirm `run_end` flips the
  status without a manual reload; open the run from history and confirm the full
  transcript + stats render.

## Out of scope

- **Cross-run analytics** (cost trends, tool-frequency, error rates over time) —
  deferred to the eventual Postgres move, where a `run_events` table with
  full-text search is the natural home.
- **Search / filter within a transcript** beyond expand/collapse.
- **Retention / pruning** of `runs/*.jsonl` (grows unbounded; note for later).
- **Backfill:** only runs created after this ships get a JSONL transcript. Older
  runs show summary stats only — the detail page renders "no transcript recorded
  for this run."
- **Cancelling a run from the UI** (already out of scope in the prior spec).
- Websockets; a `run_events` DB table; multi-user fan-out (all deferred — none
  is needed for one-way, single-user streaming).
