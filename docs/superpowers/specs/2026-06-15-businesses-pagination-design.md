# Businesses directory pagination — design

_Date: 2026-06-15_

> ## ⚠️ Flagged for rebuild review — pagination strategy (B1 vs B2)
>
> This spec implements **B1**: `listBusinessesRanked` loads the **entire filtered
> set** into server memory on every `/businesses` request to rank it (tier comes
> from `categories.json`, not SQL) and to count chains/excluded, then returns a
> single page. **Cost scales with the total number of matching businesses, not
> with page size.**
>
> - **Why it's fine now:** local in-process SQLite, one user, hundreds–low-thousands
>   of rows. The full-set scan + in-memory sort is negligible.
> - **Why it won't scale:** a larger region (more businesses) or the planned
>   multi-user / real-time rebuild (many concurrent requests) turns this
>   per-request full scan into the bottleneck. Pagination here limits *payload*,
>   not *server work*.
> - **The scalable form (B2):** generate a tier `CASE` from `categories.json` so
>   SQL does `ORDER BY … LIMIT/OFFSET` and the counts become SQL aggregates — the
>   DB returns only the page. Deferred deliberately to avoid coupling SQL to the
>   category-config shape before the rebuild settles the data model.
> - **Revisit trigger:** at the rebuild, or sooner if a single region's business
>   count or concurrent traffic makes the per-request scan noticeable.
>
> See the project's rebuild/framework direction for where this gets reconsidered.

## Problem

`/businesses` (`apps/web/src/app/businesses/page.tsx`) renders **every** matching
business as a `<details>` card in one list. It fetches up to `limit: 5000` rows
via `listBusinessesRanked`, which annotates each row with its search-priority
tier + chain flag, applies the tier4/chain visibility rules, sorts
(chains-last → tier → name), and returns the full sorted set plus `total`,
`tier4Count`, `chainCount`. For a real region this is hundreds to thousands of
cards shipped to the browser in one response — content it isn't displaying.

The fix: the data layer should **return only the requested page-worth of rows**,
with filtering behaving exactly as it does today.

## Decisions (locked)

- **Paginate in the query layer (`listBusinessesRanked`), not the view.** The
  function takes optional `page` / `pageSize` and returns **only that page's
  rows** plus the totals/counts the UI needs. The page component renders what it
  receives — it no longer holds the full set.
- **Ranking + counts still scan the filtered set server-side (approach "B1").**
  `tier` comes from `categories.json`, so the ranked order can't be a plain SQL
  `ORDER BY`, and the pill counts need the whole filtered set. So the query loads
  the filtered set, ranks/counts it in memory as today, then slices to the page.
  This keeps ranking and counts exactly correct; only the *returned* rows are
  limited. (Rejected the heavier alternative "B2" of generating a tier `CASE` to
  push `ORDER BY … LIMIT/OFFSET` into SQL — unneeded at this data size.)
  **⚠️ This is the growth-sensitive decision flagged for rebuild review — see the
  callout at the top of this doc.**
- **Pagination params are optional and default to "no paging."** Omitting them
  returns the full set, so the other caller — the agents' `list_businesses` tool
  (`packages/agents/src/mcp-tools.ts`), which reads `{ rows, total }` and passes
  no page params — is unaffected. Added return fields are additive.
- **Control style: numbered pages with ellipsis** (`‹ 1 … 4 5 6 … 12 ›`).
- **Page-size selector `25 / 50 / 100 / All`,** default **50**.
- **URL-driven, server component.** Page number and size are query params,
  consistent with the existing filter params and `hrefWith`.
- **Any filter or page-size change resets to page 1.**

## URL params

Added alongside the existing `town` / `status` / `tag` / `q` / `tier4` / `chains`:

- `page` — 1-indexed page number. Absent, non-numeric, or `< 1` → `1`. Out-of-range
  high values are clamped to the last page by the query (so a stale deep link
  after a filter shrinks the set lands on the last page, not an empty one).
- `size` — one of `"25" | "50" | "100" | "all"`. Absent or invalid → `"50"`.
  `"all"` disables paging (returns every row) and hides the numbered pager.

The web layer owns this `"all"` vocabulary; the query layer is UI-agnostic and
takes a plain numeric `pageSize` (or omitted for "no paging").

## Architecture

Three units: a query-layer change + its pure slice helper (both in the db
package, tested by its existing Vitest suite), and the web view helper + page
wiring.

### 1. Query slice helper — `packages/db/src/pagination.ts` (+ `.test.ts`)

Pure arithmetic that `listBusinessesRanked` uses to turn a requested page into a
clamped window. Lives in the db package so it's covered by the existing
`packages/db` Vitest suite — no new test runner needed for it.

```ts
// matched = number of rows after visibility filtering (the set being paged).
// page    = raw 1-indexed request. pageSize > 0.
export function resolvePage(
  matched: number,
  page: number,
  pageSize: number,
): { page: number; pageCount: number; start: number; end: number };
//   pageCount = max(1, ceil(matched / pageSize))
//   page      = clamp(page, 1, pageCount)
//   start     = (page - 1) * pageSize
//   end       = min(start + pageSize, matched)
//   matched 0 -> { page: 1, pageCount: 1, start: 0, end: 0 }
```

### 2. Query change — `packages/db/src/queries.ts`

`RankedBusinessFilters` gains:

- `page?: number` — 1-indexed; default 1; ignored when `pageSize` is absent.
- `pageSize?: number` — a positive page size. Absent or `<= 0` → no paging
  (return the full ranked set; current behavior).

`RankedBusinessList` gains (additive — existing `rows` / `total` / `tier4Count` /
`chainCount` keep their meaning):

- `matched: number` — count **after** tier4/chain visibility filtering, i.e. the
  size of the set being paged (what `rows.length` used to represent). Drives the
  "of Z" count and `pageCount`.
- `page: number` — the resolved/clamped current page (1 when not paging).
- `pageCount: number` — total pages (1 when not paging, or when `matched` is 0).

`listBusinessesRanked` flow (only the tail changes):

1. As today: annotate rows, tally `tier4Count` / `chainCount`, apply visibility
   filters, sort → call this sorted, visible array `visible`.
2. `matched = visible.length`.
3. If `filters.pageSize` is a positive number:
   `{ page, pageCount, start, end } = resolvePage(matched, filters.page ?? 1, filters.pageSize)`
   and `rows = visible.slice(start, end)`.
   Otherwise `rows = visible`, `page = 1`, `pageCount = 1`.
4. Return `{ rows, total: <annotated.length, unchanged>, matched, page, pageCount,
   tier4Count, chainCount }`.

`total` stays the pre-visibility filtered count (it powers the global empty-state
check and the agent tool's `total`), so agent semantics don't change.

Note: the inner `listBusinesses` SQL `limit` (the page passes `5000`) still bounds
how many rows are loaded for ranking/counting; `pageSize` bounds what's returned.
Leaving the `5000` cap as-is — pre-existing, out of scope.

### 3. Web view helper — `apps/web/src/lib/pagination.ts` (+ `.test.ts`)

View-only concerns, mirroring the existing `apps/web/src/lib/run-utils.ts`
pattern: pure functions, no React.

```ts
export type PageSize = 25 | 50 | 100 | "all";
export const PAGE_SIZES: PageSize[] = [25, 50, 100, "all"];

// Parse the raw ?size= value; default 50, invalid → 50.
export function parsePageSize(raw: string | undefined): PageSize;

// Numbered-pager sequence: first + last, current ±1, "…" for gaps.
export function pageWindow(
  page: number,
  pageCount: number,
): (number | "ellipsis")[];
//   pageWindow(6, 12) -> [1, "ellipsis", 5, 6, 7, "ellipsis", 12]
//   pageWindow(1, 3)  -> [1, 2, 3]
//   pageWindow(2, 1)  -> [1]
```

**Test-runner setup (prerequisite):** the web app currently has *no* test
infrastructure — only `packages/db` has Vitest. To test this helper:

- Add `vitest` (matching db's `^3.2.0`) to `apps/web` devDependencies and a
  `"test": "vitest run"` script to `apps/web/package.json`.
- Update the root `test` script to run both workspaces, e.g.
  `npm -w @localfinds/db run test && npm -w @localfinds/web run test`.

No Vitest config file is needed (db runs config-less); add one only if Vitest
requires it in practice.

### 4. Page wiring — `apps/web/src/app/businesses/page.tsx`

- Parse `size = parsePageSize(first(params.size))` and
  `pageReq = max(1, parseInt(first(params.page)) || 1)`.
- Call `listBusinessesRanked({ town, status, tag, q, limit: 5000,
  includeTier4: showTier4, includeChains: showChains, page: pageReq,
  pageSize: size === "all" ? undefined : size })`.
- Destructure `{ rows, total, matched, page, pageCount, tier4Count, chainCount }`
  and render `rows` directly (no view-side slicing).
- **`current` filters gain `size` but NOT `page`.** Because `page` isn't in
  `current`, every filter pill and the size selector naturally drop it →
  page resets to 1. Only the numbered pager re-adds `page` via the patch.
- **Page-size selector**: a new pill row ("Per page  25  50  100  All") matching
  the existing Status/Town/Show rows. Each link is `hrefWith(current, { size })`
  with the size's value (`"all"` explicit; the default 50 may be normalized to an
  absent param to keep URLs clean). Active pill = current size.
- **Numbered pager**: rendered below the list only when `size !== "all"` and
  `pageCount > 1`. Maps `pageWindow(page, pageCount)` to links via
  `hrefWith(current, { page: String(n) })`; renders `…` for `"ellipsis"`; the
  current page is highlighted and non-clickable; `‹`/`›` are plain disabled spans
  on the first/last page. Uses the query's returned (clamped) `page`.
- **Count line** becomes, when paging: `Showing {start + 1}–{start + rows.length}
  of {matched} {businesses}{ matching filters}, ranked by search priority`
  (`start = (page - 1) * size`). When `size === "all"`: `{matched} {businesses}…`
  (today's phrasing, with `matched` in place of `rows.length`).
- **Search form** hidden inputs: add a hidden `size` input (so search keeps the
  page size); do **not** add a hidden `page` input (so submitting search resets to
  page 1).

## Edge cases

- **No matches** (`matched === 0`): the existing "No businesses match these
  filters" message renders; no pager. `resolvePage` returns a valid 1-of-1 window.
- **Out-of-range `page`**: clamped to the last page by the query; the pager and
  count line use the returned clamped `page`.
- **`size=all`**: pager hidden, every row returned/rendered (today's behavior).
- **Global empty** (`total === 0 && !hasFilters`): unchanged "no businesses yet"
  message (cartographer hasn't run).
- Agents' `list_businesses` tool passes no page params → unchanged full result.

## Testing

- **`packages/db/src/pagination.test.ts`** (existing Vitest suite): `resolvePage`
  — first/middle/last page bounds; partial last page; clamp above `pageCount`;
  clamp below 1; `matched = 0`.
- **`packages/db/src/queries.test.ts`** (extend): `listBusinessesRanked` with
  `page`/`pageSize` returns the correct slice, correct `matched`/`pageCount`, and
  that omitting the params returns the full set unchanged (backward-compat guard
  for the agent caller).
- **`apps/web/src/lib/pagination.test.ts`** (newly wired Vitest, per unit 3):
  `parsePageSize` (valid values, missing → 50, garbage → 50, `"all"`);
  `pageWindow` (few pages → no ellipsis, near start, middle → two ellipses, near
  end, `pageCount` 1).

No rendering test for the page — the logic that can be wrong lives in the pure
helpers and the query.

## Out of scope

- No SQL-level tier `CASE` / `LIMIT` push-down (the rejected "B2"); the query
  still ranks in memory.
- No infinite scroll / "load more" (rejected — needs client state).
- No per-user persistence of page size (URL param only; no cookie).
- The inner `listBusinesses` `limit: 5000` ranking cap is unchanged.
