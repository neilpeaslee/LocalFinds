# Businesses page: table redesign

**Date:** 2026-06-16
**Status:** Approved, ready for planning

## Problem

`/businesses` renders each business as a `<details>` accordion card: a summary
line (tier badge, name, kind, chain badge, status, town) over a body holding
address, website, phone, the OSM link, clickable tags, and the cartographer's
markdown note. The `/sources` page was just rebuilt from the same accordion
shape into a scannable table with a detail page; this brings the businesses
directory to the same pattern.

## Goals

- Replace the accordion with a **table**: **Tier · Name · Kind · Town**.
- Make all four columns **click-to-sort**, with the existing search-priority
  ranking as the default order.
- Move each business's body (address, website, phone, OSM link, tags, note) to a
  dedicated **detail page** (`/businesses/[id]`).
- Keep the existing header card (search + status/town/chains/tier4 pills +
  per-page) and pagination exactly as they are.

## Non-goals

- Removing or reworking pagination. 656 rows across 20 towns — pagination stays.
- Changing the filter set, the tier/chain visibility rules, or the ranking
  comparator's default behavior.
- Editing businesses from the UI. The cartographer agent still owns writes.
- Changing the `businesses` schema.

## Key design point: sorting lives in the query layer

Unlike `/sources` (14 rows, sorted in the page), `/businesses` is paginated, so
**column sorting must happen before pagination — i.e. in the query**, not over
the visible page. `listBusinessesRanked` already sorts the full matched set in
JS *before* slicing for the page, so this is an extension of existing code.

That ordering logic moves into a **pure, unit-tested helper** in `packages/db`
(it must run where sorting runs). The `undefined` sort case reproduces today's
ranking comparator **exactly** — both the `/businesses` page and the agents'
`list_businesses` MCP tool depend on `listBusinessesRanked`'s current default
order, so that behavior must not drift.

## Data model (existing, unchanged)

`Business` (`packages/db/src/schema.ts`): `id, osmId (unique), name, kind,
tags[], address, town, lat, lng, website, phone, brand, status
("active"|"closed"|"unknown"), notesPath, addedBy, discoveredAt, lastSeenAt,
duplicateOf`.

Each business may have a cartographer note via `readAgentNote("cartographer",
notesPath)`. Search-priority `tier` comes from `readCategoryConfig().tierOf(kind)`;
`isChain` is `Boolean(brand)`.

## Architecture

All server components, `force-dynamic`, all state in the URL query string — same
as today and as `/sources`.

### Files

| File | Change |
|------|--------|
| `packages/db/src/business-sort.ts` | New: sort types, comparator, param parsers |
| `packages/db/src/business-sort.test.ts` | New: unit tests for the comparator + parsers |
| `packages/db/src/queries.ts` | Extend `listBusinessesRanked` with `sort`/`dir`; add `getBusinessById` |
| `apps/web/src/app/businesses/page.tsx` | Rewrite accordion → sortable table |
| `apps/web/src/app/businesses/[id]/page.tsx` | New: business detail page |

> Merge note: `queries.ts` and `queries.test.ts` are also touched by the open
> `/sources` PR. Place `getBusinessById` next to `listBusinessesRanked` (far from
> the sources `getSourceById`/`listFindsBySource` additions near `listSources`),
> and append the business-query test in its own block, to keep the eventual
> merge trivial.

### `packages/db/src/business-sort.ts` (new)

```ts
import type { RankedBusiness } from "./queries"; // type-only — no runtime cycle

export type BusinessSort = "tier" | "name" | "kind" | "town";
export type SortDir = "asc" | "desc";

// undefined sort = the default search-priority ranking (chains-last → tier →
// name). Any explicit sort overrides it. Null kind/town sort last in both
// directions. Returns a NEW array.
export function sortRankedBusinesses(
  rows: RankedBusiness[],
  sort: BusinessSort | undefined,
  dir: SortDir,
): RankedBusiness[];

export function parseBusinessSort(raw: string | undefined): BusinessSort | undefined;
export function parseDir(raw: string | undefined): SortDir; // default "asc"
```

Default branch (`sort === undefined`) reproduces today's comparator byte-for-byte:
`Number(a.isChain) - Number(z.isChain) || a.tier - z.tier ||
a.business.name.localeCompare(z.business.name)`.

Explicit-sort comparators (then apply `dir` as a sign; nulls always last):
- `name`: `a.business.name.localeCompare(z.business.name)`
- `town`: `localeCompare` on `town`, nulls last; tiebreak by name
- `kind`: `localeCompare` on `kind`, nulls last; tiebreak by name
- `tier`: `a.tier - z.tier`; tiebreak by name

### `packages/db/src/queries.ts` changes

- `RankedBusinessFilters` gains `sort?: BusinessSort` and `dir?: SortDir`.
- `listBusinessesRanked` replaces its inline `.sort(...)` call with
  `sortRankedBusinesses(visible, filters.sort, filters.dir ?? "asc")`, leaving
  the tier4/chain visibility filter and pagination slice unchanged. With no
  `sort`, output is identical to today.
- Add, next to `listBusinessesRanked`:
  ```ts
  export function getBusinessById(id: number): Business | undefined {
    return db().select().from(businesses).where(eq(businesses.id, id)).get();
  }
  ```

## UI

### `/businesses` page

Header card, summary line, and pagination are unchanged except for threading the
new `sort`/`dir` params through. Specifically:

- Parse `sort = parseBusinessSort(first(params.sort))` and
  `dir = parseDir(first(params.dir))`; pass both to `listBusinessesRanked`.
- Add `sort`/`dir` to the `current` object (so filter pills, per-page links, and
  the pager preserve the active sort) with defaults dropped for clean URLs
  (`sort` omitted when undefined; `dir` omitted when `"asc"`).
- Add hidden `sort`/`dir` inputs to the search form.
- The summary line keeps its count and `matching filters` clause; its trailing
  clause is `ranked by search priority` when no sort is active, else `sorted by
  <column> (<A–Z|Z–A|low–high|high–low>)`.

Table — columns **Tier · Name · Kind · Town**:

- **Tier** → existing `T1`–`T4` `TIER_STYLE` badge.
- **Name** → `<Link>` to `/businesses/[id]`; a small `chain` badge (with brand,
  per today) when `isChain`; a `↗` to `website` (new tab, `aria-label`'d) when a
  website exists.
- **Kind** → raw `kind` or `—`. **Town** → `town` or `—`.
- All four headers are **click-to-sort** links toggling `?sort=&dir=` (asc↔desc),
  with `aria-sort` and a ▲/▼ on the active column. Headers also carry
  `scope="col"`. Default = no `sort` param = ranking, so **no column shows an
  arrow until clicked**. Clicking a header resets to page 1 (drops `page`).
- Right-align is not required (Tier/Kind/Town are short text); keep left
  alignment with the existing cell padding idiom.

Empty states (unchanged in spirit): the "no businesses yet — run the
cartographer" seed hint when the directory is truly empty, and "No businesses
match these filters." when a filter yields nothing.

### `/businesses/[id]` detail page

Mirrors `/sources/[id]`:

- "← Back to businesses" Link to `/businesses`.
- Header: name + `↗` website link (when present); the `T#` tier badge, the kind
  badge, a `chain` badge when `isChain`, the status badge, and the town.
- Contact line: `address · phone · website · <osmId>` where `<osmId>` links to
  `https://www.openstreetmap.org/<osmId>` (new tab); each segment omitted when
  null/empty.
- **Tags** as chips, each linking to `/businesses?tag=<tag>` (preserving today's
  tag-filter affordance from the accordion body).
- The cartographer **note**: `readAgentNote("cartographer", b.notesPath)` as
  markdown (`react-markdown` + `remark-gfm`, `prose prose-sm prose-stone`), or
  "No note yet." when absent.
- Tier/kind/chain/status are derived on the page from `readCategoryConfig()` and
  `business.brand`, the same way the listing derives them.
- `notFound()` (404) when the id isn't a positive integer (`Number(idParam)`
  guard, same as `/sources/[id]`) or `getBusinessById` returns undefined.

## Data flow

Server components, `force-dynamic`. `page.tsx` reads `searchParams` → parses
filters + `sort`/`dir` → `listBusinessesRanked({...filters, sort, dir, page,
pageSize})` → renders the header, summary, table, and pager. The detail page
awaits `params`, guards the id, then calls `getBusinessById`,
`readCategoryConfig` (for tier), and `readAgentNote` (for the note). No
client-side state.

## Testing

`packages/db/src/business-sort.test.ts` (TDD, before the helper), covering:

- Default (`undefined` sort): chains sort last; within non-chains, tier ascending
  then name; stable, matching today's order.
- `name` asc/desc.
- `town` and `kind`: null values sort last in both directions; tiebreak by name.
- `tier` asc/desc with name tiebreak.
- `parseBusinessSort`: valid keys pass; unknown/undefined → `undefined`.
- `parseDir`: `"desc"` → `"desc"`; anything else → `"asc"`.

A light integration assertion in `queries.test.ts` that `listBusinessesRanked({
sort: "name" })` reorders relative to the default, plus a `getBusinessById`
found/undefined test (own block, to avoid clashing with the sources PR).

Manual: load `/businesses`, exercise search + each filter pill + per-page +
each sortable header (asc/desc) + pagination together; click through to a detail
page; confirm contact line, tag-chip filtering, and the note render; hit
`/businesses/999999` and `/businesses/abc` for the 404.

## Risks / notes

- **Regression-sensitive:** the `undefined`-sort branch must exactly match the
  current ranking — the agents tool and the directory both depend on it. The
  default-order test guards this.
- Column sorting + pagination interact: sorting reorders the full matched set
  before slicing, so page numbers stay meaningful. Clicking a sort header resets
  to page 1.
- `new URL(b.website).hostname` is not used (we link the raw website); the OSM
  link is built by string concatenation, as today.
