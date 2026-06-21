# iCal feeds as a first-class source type

**Date:** 2026-06-21
**Status:** Approved (design)
**Area:** `packages/agents`, `packages/db`

## Problem

Some local venues block the agents' `WebFetch` (HTTP 403) on their HTML event
pages — Owls Head Transportation Museum is the standing example: both its
homepage and `/events/` return 403 to the Agent SDK WebFetch, and source-keeper
has paused it. Yet the events are real and current.

These sites commonly run **The Events Calendar** (WordPress plugin; owlshead's
feed advertises `PRODID: ...ECPv6.16.3`), which exposes a public **iCal feed**.
Verified: `https://owlshead.org/events/?ical=1` returns **HTTP 200** with a valid
`VCALENDAR` (30 `VEVENT`s, each with `SUMMARY`, `DTSTART`+`TZID`, and a
per-event `URL`) at the very path whose HTML returns 403. The feed is both
**structured** and **unblocked**.

Opportunity: treat iCal feeds as a first-class source type. This turns blocked
venues into reliable structured sources and generalizes to any ECP-style venue.

## What was verified

- `curl` with a browser User-Agent gets `200` + `BEGIN:VCALENDAR` from
  `owlshead.org/events/?ical=1`, `…/?post_type=tribe_events&ical=1`, and
  `…/events/list/?ical=1`. The agent's SDK WebFetch 403s the HTML; the feed is a
  different access path.
- The feed carries exactly the fields a find needs: `SUMMARY`, `DTSTART`
  (with `TZID`), `DTEND`, `URL` (per-occurrence, e.g.
  `/event/camp-pit-stop-pals/2026-06-29/`), `LOCATION`.

## Scope

In scope (this spec — the full pipeline):

- A `fetch_ical` MCP tool: raw fetch (browser UA) + candidate-URL resolution +
  parse → compact upcoming-events JSON.
- A tiny, pure iCal parser module.
- A `sources.ical_url` column + `upsert_source` support.
- source-keeper **discovery**: probe sources for a feed, record `ical_url`, and
  auto-activate a feed-backed source.
- scout **consumption**: pull events from feed-backed sources and save finds.

Out of scope (YAGNI / deferred):

- `RRULE` recurrence expansion. ECP emits per-occurrence dated VEVENTs; we take
  each VEVENT's `DTSTART` as-is. If an `RRULE` is present we use its `DTSTART`
  and do not expand it.
- Non-ECP calendar systems beyond what the candidate probes happen to hit.
- A dedicated UI. (Feeds surface through normal finds and the sources list.)
- Auth'd / private calendars.

## Architecture

`fetch_ical` mirrors `overpass_query`: an in-process MCP tool doing a raw
`fetch` POST/GET with a real browser `User-Agent` (NOT WebFetch — WebFetch
converts to markdown, 403s with the agent UA, and is subject to the WebFetch
PreToolUse guard). Parsing lives in a pure module (`ical.ts`) like `overpass.ts`
so it is unit-testable without the SDK. The discovered feed URL is an exact fact
and is stored in the `sources` table.

**Interaction with the fetch-logging/blocking work:** none. `fetch_ical` is an
MCP tool; the `WebFetch` `PreToolUse` guard matches only the `WebFetch` tool, so
a host hard-blocked for HTML WebFetch (e.g. owlshead) remains fully usable via
`fetch_ical`. The feed is simply a better access path.

## Components

### 1. Parser — `packages/agents/src/ical.ts` (pure)

Pure logic + parsing only (no SDK/db imports), mirroring `overpass.ts`.

```
export interface ICalEvent {
  summary: string | null;
  start: string | null;   // ISO 8601
  end: string | null;     // ISO 8601
  url: string | null;
  location: string | null;
}
export function parseICal(text: string): ICalEvent[];
export function isVCalendar(text: string): boolean;   // body sniff
export function icalCandidates(url: string): string[]; // discovery URL list
```

Parser rules:
- **Unfold** RFC-5545 continuation lines first (a line beginning with a space or
  tab continues the previous line; strip the single leading whitespace).
- Walk `BEGIN:VEVENT` … `END:VEVENT` blocks; ignore everything else
  (`VTIMEZONE`, `VCALENDAR` headers).
- Per event extract `SUMMARY`, `DTSTART`, `DTEND`, `URL`, `LOCATION`.
- Property params are allowed (`DTSTART;TZID=America/New_York:20260627T100000`,
  `DTSTART;VALUE=DATE:20260627`). Split on the first unquoted `:`; read params
  after `;`.
- **Dates → ISO:** `YYYYMMDD` → `YYYY-MM-DD`; `YYYYMMDDTHHMMSS` →
  `YYYY-MM-DDTHH:MM:SS`; trailing `Z` preserved (UTC). `TZID` is recorded by
  keeping the local datetime string as-is (no tz-math; the find stores wall-clock
  local time, consistent with how the agents record published dates).
- **Unescape** text values: `\,`→`,`, `\;`→`;`, `\n`/`\N`→newline, `\\`→`\`.
- Never throw on a malformed line — skip it; a malformed event yields whatever
  fields parsed (or is dropped if it has no `DTSTART`).

`icalCandidates(url)`: returns the probe order — the URL as given, then, derived
from its origin/path, the common ECP forms: `<url with ?ical=1>`,
`<origin>/events/?ical=1`, `<origin>/?post_type=tribe_events&ical=1`,
`<origin>/events/list/?ical=1`. De-duplicated, capped at ~5.

### 2. Raw fetch + tool — `packages/agents/src/ical.ts` + `mcp-tools.ts`

The HTTP function lives in the SAME `ical.ts` module as the parser — mirroring
`overpass.ts`, which holds both pure logic and `runOverpass` and stays testable
via an injected `fetchImpl`. (So `ical.ts` exports the parser pieces from
Component 1 plus `runIcalFetch` and `formatIcalResult` below.)

`runIcalFetch` (HTTP, isolated like `runOverpass`):

```
export async function runIcalFetch(
  url: string,
  fetchImpl?: typeof fetch,
): Promise<
  | { ok: true; feedUrl: string; events: ICalEvent[] }
  | { ok: false; error: string; status?: number }
>;
```

Behavior: for each candidate from `icalCandidates(url)`, GET with a browser
`User-Agent`, `AbortController` timeout (~25s), follow redirects. The first
response that is `2xx` AND whose body `isVCalendar` wins → parse and return
`{ ok, feedUrl, events }`. If none qualify, return the last error/status.

`formatIcalResult(result, limit?)` in `ical.ts` (mirrors `formatOverpassResult`):
on success, **filters to upcoming** events (`start` ≥ today, date-prefix compare;
events with no `start` dropped), sorts by `start` ascending, caps to `limit`
(default 30, max ~60), projects to the `ICalEvent` fields, and returns
`{ feedUrl, matched, returned, truncated, events }` as a `ToolTextResult`; on a
failed fetch returns `isError: true` with `{ error, status }` (so it counts as a
run warning).

`mcp-tools.ts` adds the `fetch_ical` tool: input `{ url: string; limit?: number }`;
body is `formatIcalResult(await runIcalFetch(args.url), args.limit)` — the same
one-line shape as the `overpass_query` tool.

### 3. Storage — `packages/db`

- `schema.ts`: add `icalUrl: text("ical_url")` (nullable) to `sources`.
- `queries.ts`: `upsertSource` accepts an optional `icalUrl` and writes it;
  `listSources` already returns full rows, so `ical_url` flows to consumers (the
  `list_sources` tool projection, if any, must include it).
- Requires `npx drizzle-kit push` to add the column (tests run it in `beforeAll`;
  dev/prod run it as a deploy step — same as the `fetches` table).

### 4. Discovery — source-keeper

- Add `fetch_ical` to source-keeper's `allowedTools`; add `ical_url` to the
  `upsert_source` tool's input schema.
- Prompt: during the existing stalest-source recheck, for a source without an
  `ical_url`, call `fetch_ical(source.url)`; if it returns a `feedUrl`, record it
  via `upsert_source({ url, ical_url: feedUrl, status: "active" })` — a
  feed-backed source is reachable, so **auto-activate** it (this un-pauses
  owlshead). Keep the site note updated as usual.

### 5. Consumption — scout

- Add `fetch_ical` to scout's `allowedTools`.
- Prompt: after `list_sources`, for sources that have an `ical_url`, call
  `fetch_ical(ical_url)`, triage the returned upcoming events against
  `list_recent_finds`, and `save_find` the genuine ones — each VEVENT carries its
  own `url` for clean dedupe. Feed events count toward the run's normal
  quality-over-quantity guidance; they do not bypass the honesty rule (the feed
  *is* the venue's own primary source, so a feed event is confirmed).

## Data flow

1. source-keeper rechecks a stale source → `fetch_ical(source.url)` resolves a
   feed → `upsert_source({ ical_url, status: "active" })`.
2. scout lists sources → sees `ical_url` → `fetch_ical(ical_url)` → upcoming
   events → `save_find` per genuine event.

## Error handling / edge cases

- Unreachable feed / non-VCALENDAR body for all candidates → tool `isError:true`
  with status; agents proceed. No crash.
- All-day (`VALUE=DATE`) vs timed (`TZID`) events both parse; `end` may be null.
- Empty/past-only feed → `events: []` (not an error).
- Large feed → cap + `truncated: true` (owlshead is ~735 KB raw → a few KB out).
- `fetch_ical` is exempt from the WebFetch guard by construction (different tool).

## Testing

Pure unit tests (no network):
- `parseICal` against a checked-in fixture `.ics` covering: folded continuation
  lines, `TZID` datetime, `VALUE=DATE` all-day, escaped `\,`/`\n`, an event
  missing `DTSTART` (dropped), and a `VTIMEZONE` block (ignored).
- `isVCalendar` true/false; `icalCandidates` ordering + de-dup.
- The tool projection: upcoming-only filter (a past event is excluded), sort,
  cap + `truncated`, and `isError` on a simulated failed fetch (inject a
  `fetchImpl`), mirroring `overpass.test.ts`.
- `upsertSource` `ical_url` round-trip (db tests).

Agent-loop/prompt wiring is not unit-tested (consistent with the codebase);
verified by a live source-keeper run (discovers owlshead feed) then a scout run
(saves owlshead events).

## Rollout

Additive. With no `ical_url` set anywhere, behavior is unchanged. The column
needs `drizzle-kit push` on the live DB. First win is operational: a
source-keeper run discovers owlshead's feed and re-activates it; the next scout
run pulls its events.
