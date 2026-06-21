# Scout fetch logging + host-blocking memory

**Date:** 2026-06-21
**Status:** Approved (design)
**Area:** `packages/agents`, `packages/db`

## Problem

Scout (and the other Agent-SDK agents) fetch pages via the built-in `WebFetch`
tool. Recent runs show two recurring, invisible costs:

1. **Repeated dead-end fetches.** Some hosts return `HTTP 403 Forbidden` every
   run (e.g. Owls Head Transportation Museum, Farnsworth). Scout re-discovers the
   same blocks each run, spending fetches (and budget) on pages it can never read.
2. **No observability.** WebFetch failures come back with `isError: false`, so
   they don't even show in the run's warning count. There is no record of which
   hosts/URLs were fetched, or what happened.

Run 28 (2026-06-21) did 10 fetches and saved only 4 finds; several genuine
events could not be confirmed because their pages 403'd or were truncated.

## What the Agent SDK actually allows (investigated)

- The API `web_fetch` server tool supports `max_uses`, `blocked_domains`,
  `max_content_tokens`. **These are NOT exposed** on the Agent SDK
  (`@anthropic-ai/claude-agent-sdk` v0.3.175) WebFetch — its input is only
  `{url, prompt}`.
- The SDK's `WebFetchOutput` type carries `code`/`codeText`/`bytes`, but our
  message loop never receives the structured output: by the time a WebFetch
  result reaches `projectMessage`, it is flattened to **text**
  (`"The server returned HTTP 403 Forbidden."`, `"[Content truncated due to
  length...]"`, or the page markdown). So exact codes are not available from
  WebFetch, but a **coarse** class is derivable by parsing that text.
- A model-independent hard block is achievable with a `PreToolUse` hook on
  `WebFetch` (we already run such a hook — the path-guard for file tools).

## Scope

In scope (this spec):

- A `fetches` log table, populated automatically from WebFetch results.
- Coarse status classification of WebFetch result text.
- Hard host-blocking after **N=3** consecutive **403/401** outcomes, enforced by
  a `PreToolUse` hook and surfaced to scout via its prompt.

Explicitly out of scope (YAGNI / deferred):

- A custom `fetch_url` MCP tool (browser User-Agent, redirects, exact codes,
  page recovery). The `fetches.via` column is reserved so it can be added later
  with no migration.
- Changing the fetch-count cap (currently prompt-only).
- Auto-writing to the `sources` table.
- A new UI page. (Run-detail surfacing may be added later.)
- Auto-probing/auto-unblocking a hard-blocked host. Un-blocking is manual.

## Data model

New table in `packages/db/src/schema.ts`:

```
fetches
  id        integer pk autoincrement
  runId     integer  -> runs.id
  agent     text     not null
  host      text     not null          -- normalized lowercase hostname
  url       text     not null
  method    text     not null default 'GET'
  status    integer                    -- HTTP code when known (e.g. 200, 403); nullable
  klass     text     not null          -- 'ok' | 'blocked' | 'truncated' | 'error'
  via       text     not null default 'webfetch'
  ts        text     not null          -- ISO 8601
  index fetches_host_idx (host)
  index fetches_run_idx  (runId)
```

`klass` is the durable signal; `status` is best-effort: the classifier assumes
`200` for `ok`/`truncated` (WebFetch text rarely states a code on success) and
records the parsed code for `blocked`/`error`. The column is nullable only so a
future `via='fetch_url'` row (or an unclassifiable result) can omit it.

No DB migration tooling is in use beyond `schema.ts` + table creation on open;
the new table is created the same way the others are.

## Components

### 1. `classifyWebFetchResult(text)` — pure helper

New module `packages/agents/src/web-fetch-log.ts` (pure logic + parsing only, no
SDK/db imports, mirroring `overpass.ts` so it stays unit-testable).

```
classifyWebFetchResult(text: string): { klass: FetchClass; status: number | null }
```

Rules (first match wins):

- `/HTTP (\d{3})/i` →
  - 401 or 403 → `{ klass: 'blocked', status }`
  - any other code → `{ klass: 'error', status }`
- contains `"[Content truncated due to length"` → `{ klass: 'truncated', status: 200 }`
- otherwise → `{ klass: 'ok', status: 200 }`

`FetchClass = 'ok' | 'blocked' | 'truncated' | 'error'`.

The WebFetch result content may arrive as a string or as `[{type:'text',
text}]`; the helper's caller normalizes to a string first.

### 2. `recordFetch(...)` and `blockedHosts(...)` — db (`queries.ts`)

```
recordFetch(input: {
  runId: number; agent: string; host: string; url: string;
  status: number | null; klass: FetchClass; via?: string;
}): void
```

Inserts one row, stamping `ts` and defaulting `method='GET'`, `via='webfetch'`.

```
blockedHosts(strikes = 3): string[]
```

Returns hosts to hard-block: a host qualifies when its **most-recent `strikes`
fetch outcomes are all `klass='blocked'`** with no `ok`/`truncated` interleaved.
429 and 5xx (`klass='error'`) and `truncated` do **not** count as strikes and
**break** a blocked streak (a host that later returns anything non-blocked resets).

Implementation: per host, read recent rows ordered by `ts` desc; count the
leading run of `blocked`; qualifies if that run length `>= strikes`. Computed in
code over a bounded recent window (e.g. last 50 rows/host) for clarity over a
single SQL window query.

`STRIKE_THRESHOLD = 3` lives as a named constant in `packages/agents` and is
passed into `blockedHosts`.

Manual un-block helper:

```
clearFetchHistory(host: string): number   // deletes that host's rows; returns count
```

### 3. `run-agent` wiring

At run start (before the `query()` loop):

- `const blocked = blockedHosts(STRIKE_THRESHOLD)`
- If non-empty, append a prompt section:
  `"## Hosts to skip\nThese hosts repeatedly returned 403/401 — do not fetch
  them this run: <host, host, ...>"` (avoids wasting a turn on a denial).
- Install a second `PreToolUse` hook entry matching `WebFetch` (alongside the
  existing file-tool path-guard) that denies the call when the URL's host is in
  `blocked`, returning a short reason ("host X blocked after repeated 403s —
  skip it"). The deny is the guarantee, independent of model compliance.

During the loop:

- Maintain `const fetchUrls = new Map<string, string>()` (toolUseId → url) from
  WebFetch `tool_use` blocks (`block.name === 'WebFetch'`, `block.input.url`).
- On a `tool_result` whose `tool_use_id` is in `fetchUrls`: normalize content to
  text, `classifyWebFetchResult`, resolve `host` from the url, and `recordFetch`.
  Drop the entry from the map.

This reuses the existing per-message iteration; no extra SDK round-trips.

### 4. Hook helper

`makeWebFetchGuard(blockedHosts: Set<string>)` in `packages/agents/src/path-guard.ts`
(or a sibling). Parses the tool input URL, denies when `host` is blocked. Fails
open on an unparseable URL (let WebFetch reject it) — the guard's job is the
blocklist, not URL validation.

## Error handling / edge cases

- **Unparseable URL** in a WebFetch input → log nothing for it / guard fails
  open. Never throw inside the loop; a logging failure must not fail the run
  (wrap `recordFetch` in try/catch like the cartographer dedupe sweep).
- **Result content shape** varies (string vs text-block array) → normalize.
- **429 / 5xx** → `klass='error'`, logged, never a strike (transient).
- **Truncation** → `klass='truncated'`, logged, never a strike (size issue).
- **bypassPermissions**: the agents run with `permissionMode:
  'bypassPermissions'`; the hard block is enforced by the `PreToolUse` hook
  (which runs regardless), not by permission rules.

## Testing

Unit (no network, no SDK):

- `classifyWebFetchResult`: 403 → blocked/403; 401 → blocked/401; arbitrary
  `HTTP 500` → error/500; truncated marker → truncated/200; plain content →
  ok/200; text-block-array input.
- `blockedHosts`: exactly N blocked → blocked; N-1 → not; streak broken by an
  `ok` → not blocked; `error`/`truncated` interleaved → not a strike; multiple
  hosts independent.
- `makeWebFetchGuard`: denies blocked host, allows others, fails open on bad URL.

Existing `run-agent` / `run-events` tests stay green; the new logging path is
additive.

## Rollout

Additive and behind data: with an empty `fetches` table, `blockedHosts` returns
`[]` and behavior is unchanged except that fetches are now logged. Hard-blocking
begins only once a host accumulates 3 consecutive 403/401s.
