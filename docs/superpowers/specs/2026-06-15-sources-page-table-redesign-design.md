# Sources page: table redesign

**Date:** 2026-06-15
**Status:** Approved, ready for planning

## Problem

The `/sources` page renders each source as a `<details>` accordion card whose
summary line packs name, URL, status, and stats together, and whose body holds
the source-keeper's markdown site note. There is no search, no filtering, and no
at-a-glance summary of the source list. With the set curated and growing slowly
(14 today), a scannable table with a search/filter header reads far better.

## Goals

- Replace the accordion list with a real table: **Name · Status · Finds ·
  Quality · Last checked**.
- Add a header card holding a **summary line**, a **search box**, and a
  **status filter** — mirroring the existing `/businesses` header pattern.
- Move each source's markdown site note to a dedicated **detail page**
  (`/sources/[id]`), keeping the table clean.
- Make the table columns **click-to-sort**.

## Non-goals

- Pagination. 14 sources today; filtering/sorting happen in-page over the full
  list. Revisit only if the set grows into the hundreds.
- Editing sources from the UI. The source-keeper agent still owns writes.
- Changing the `sources` schema or the `listSources()` signature (an agent tool
  in `packages/agents/src/mcp-tools.ts` depends on the current signature).

## Data model (existing, unchanged)

`Source` (from `packages/db/src/schema.ts`):
`id, url (unique), name, notesPath, status ("active"|"paused"|"dead"),
qualityScore, findsCount, lastFindAt, lastCheckedAt, addedBy, createdAt`.

Each source may have a markdown note read via `readAgentNote("source-keeper",
notesPath)`. Finds reference their source via `finds.sourceId`.

## Architecture

All server components, `export const dynamic = "force-dynamic"` (as today).
Filter/sort/summary state lives entirely in the URL query string — server
rendered, shareable, no client-side JS.

### Files

| File | Change |
|------|--------|
| `apps/web/src/app/sources/page.tsx` | Rewrite: header card + table |
| `apps/web/src/app/sources/[id]/page.tsx` | New: source detail page |
| `apps/web/src/lib/sources.ts` | New: pure helpers (summary/filter/sort) |
| `apps/web/src/lib/sources.test.ts` | New: unit tests for the helpers |
| `packages/db/src/queries.ts` | Add `getSourceById`, `listFindsBySource` |

### New queries (additive, in `packages/db/src/queries.ts`)

```ts
// Single source by id, or undefined.
export function getSourceById(id: number): Source | undefined

// A source's finds, newest first. Default limit 10.
export function listFindsBySource(sourceId: number, limit?: number): Find[]
//   select * from finds where source_id = ? order by discovered_at desc limit ?
```

`listSources()` is left untouched.

### Pure helpers (`apps/web/src/lib/sources.ts`)

Extracted so the filter/sort/summary logic is unit-testable, following the
existing `lib/pagination.ts` (+ `pagination.test.ts`) convention.

```ts
export type SourceSort = "name" | "finds" | "quality" | "checked";
export type SortDir = "asc" | "desc";

export interface SourceSummary {
  total: number;
  byStatus: Record<"active" | "paused" | "dead", number>;
  totalFinds: number;
  avgQuality: number | null; // null when no source has a quality score
}

// Computed over ALL sources (not the filtered set) — a stable dashboard line.
export function summarizeSources(sources: Source[]): SourceSummary;

// Case-insensitive substring match of `q` against name + url; status exact.
export function filterSources(
  sources: Source[],
  opts: { q?: string; status?: Source["status"] },
): Source[];

// Stable sort by the chosen key/direction. Nulls (e.g. missing quality or
// lastCheckedAt) sort last regardless of direction. Default: name asc.
export function sortSources(
  sources: Source[],
  sort: SourceSort,
  dir: SortDir,
): Source[];
```

## UI

### `/sources` page

Header card (single white card, `rounded-lg border border-stone-200 bg-white`),
three stacked rows:

```
┌────────────────────────────────────────────────────────────┐
│ 14 sources · 12 active · 2 paused · 19 finds · avg qual 6.8  │  summary
│ [ Search by name or URL…                       ] [ Search ]  │  search (GET form)
│ Status:  all · active · paused · dead                        │  filter pills
└────────────────────────────────────────────────────────────┘
```

- **Summary** built from `summarizeSources(allSources)`. Status segments shown
  only for non-zero counts. `avg qual X.X` omitted when `avgQuality` is null.
- **Search**: a GET `<form action="/sources">` with `name="q"`, preserving the
  active `status`/`sort`/`dir` as hidden inputs (same approach as `/businesses`).
- **Status pills**: `all · active · paused · dead`, linked via query params;
  `all` clears `status`. Active pill styled like the `/businesses` `pill()`
  helper. All four statuses always shown (dead may be zero today).

Result line under the card: `14 sources`, or `8 of 14 matching filters` when a
filter is active.

Table (`Name · Status · Finds · Quality · Last checked`):

- **Name** → links to `/sources/[id]`; a small `↗` beside it opens the real
  source `url` in a new tab (`target="_blank" rel="noopener noreferrer"`).
- **Status** → existing colored badge (active=green, paused=stone, dead=red).
- **Finds** → `findsCount`. **Quality** → `qualityScore?.toFixed(1)` or `—`.
  **Last checked** → `lastCheckedAt` as a short locale date, or `—`.
- **Sortable headers** on Name, Finds, Quality, Last checked: each is a link
  that sets `?sort=<key>&dir=<asc|desc>`, toggling direction when already the
  active sort; the active header shows a ▲/▼ indicator. Default `name`/`asc`.
- Width: lives in the `max-w-3xl` (~768px) main container; the five chosen
  columns fit without horizontal scroll.

Empty states:

- **No sources at all** — keep today's seed hint ("The source-keeper agent
  populates this on its first run…").
- **No matches for the active filter** — "No sources match these filters."

### `/sources/[id]` detail page

- Back link to `/sources`.
- Header: source **name** + `↗` external link to `url`; **status** badge; a
  metadata line: `quality X.X · N finds · checked <date> · added by <agent> ·
  created <date>` (each segment omitted when its value is null).
- **Site note**: full markdown via `readAgentNote("source-keeper",
  source.notesPath)`, same `prose prose-sm` rendering as today; "No site note
  yet." when absent.
- **Recent finds from this source**: `listFindsBySource(id, 10)` → a compact
  list of title (linked to `find.url` when present), discovered date, and
  status badge. Omitted entirely when the source has no finds.
- `notFound()` (Next.js 404) when `getSourceById` returns undefined or the id
  param isn't a positive integer.

## Testing

`apps/web/src/lib/sources.test.ts` (TDD, written before the helpers), covering:

- `summarizeSources`: status counts, total finds sum, average quality, and the
  `avgQuality === null` case when no source has a score.
- `filterSources`: case-insensitive name/url substring; status exact match;
  combined q + status; empty `q` returns all.
- `sortSources`: each key asc + desc; nulls sort last in both directions;
  default name/asc; stable ordering on ties.

Manual check: load `/sources`, exercise search + each status pill + each
sortable header, click through to a detail page, confirm the note and recent
finds render, and hit `/sources/999999` for the 404.

## Risks / notes

- Sorting and the recent-finds list are additions beyond the literal request;
  both were approved and are self-contained (a header-link change and one
  query) if either needs to be cut later.
- Keep `listSources()` unchanged — the agents MCP tool calls it with no args.
