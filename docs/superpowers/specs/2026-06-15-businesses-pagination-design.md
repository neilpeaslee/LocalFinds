# Businesses directory pagination — design

_Date: 2026-06-15_

## Problem

`/businesses` (`apps/web/src/app/businesses/page.tsx`) renders **every** matching
business as a `<details>` card in one list. It fetches up to `limit: 5000` rows
via `listBusinessesRanked`, which annotates each row with its search-priority
tier + chain flag, applies the tier4/chain visibility rules, sorts
(chains-last → tier → name), and returns the full sorted set plus `total`,
`tier4Count`, `chainCount`. For a real region this is hundreds to thousands of
cards in a single DOM — a long scroll with no way to page through it.

Ranking and sorting happen **in memory** (tier comes from `categories.json`, the
sort is JS), so a SQL `LIMIT/OFFSET` can't apply to the ranked order. Pagination
is therefore a slice of the already-sorted result set, not a database concern.

## Decisions (locked)

- **Slice in the page component, not the query layer.** `listBusinessesRanked`
  keeps its current contract (returns the full sorted `rows` + accurate counts).
  The page slices `rows` to the current window and renders the pager. This leaves
  the DB package untouched, so the other caller — the agents' `list_businesses`
  tool — is unaffected. Since the sort already materializes the whole set, there
  is no performance cost to slicing in the view.
- **Control style: numbered pages with ellipsis.** Always show first + last page,
  current ±1, and `…` for gaps, with `‹`/`›` prev/next arrows.
- **Page-size selector with `25 / 50 / 100 / All`.** Default **50**.
- **URL-driven, no client state.** The page stays a server component. Page number
  and size are query params, consistent with the existing filter params and the
  `hrefWith` helper.
- **Any filter or page-size change resets to page 1** (those links drop `page`).

## URL params

Added alongside the existing `town` / `status` / `tag` / `q` / `tier4` / `chains`:

- `page` — 1-indexed page number. Absent, non-numeric, or `< 1` → `1`.
  Clamped to `[1, pageCount]` so an out-of-range value lands on the last page
  rather than an empty list.
- `size` — one of `"25" | "50" | "100" | "all"`. Absent or invalid → `"50"`.
  `"all"` disables paging (renders every row, the current behavior) and hides the
  numbered pager.

## Architecture

Two units: a pure helper (testable without rendering) and the page wiring.

### 1. Pagination helper — `apps/web/src/lib/pagination.ts` (+ `.test.ts`)

Mirrors the existing `apps/web/src/lib/run-utils.ts` pattern: pure functions, no
React. Owns all the arithmetic so the page component stays declarative.

**Test-runner setup (prerequisite):** the web app currently has *no* test
infrastructure — only `packages/db` has Vitest. This helper's `.test.ts` needs a
runner, so as part of this work:

- Add `vitest` (matching db's `^3.2.0`) to `apps/web` devDependencies and a
  `"test": "vitest run"` script to `apps/web/package.json`.
- Update the root `test` script so it runs both workspaces, e.g.
  `npm -w @localfinds/db run test && npm -w @localfinds/web run test`.

No Vitest config file is needed for either workspace today (db runs config-less),
so none is added unless Vitest requires one in practice.

```ts
// Allowed page sizes. "all" means no paging.
export type PageSize = 25 | 50 | 100 | "all";
export const PAGE_SIZES: PageSize[] = [25, 50, 100, "all"];

// Parse the raw ?size= value; default 50, invalid → 50.
export function parsePageSize(raw: string | undefined): PageSize;

// Given total item count, raw ?page=, and the chosen size, return the resolved
// window: clamped 1-indexed page, total page count, and slice bounds.
export function resolvePage(
  total: number,
  rawPage: string | undefined,
  size: PageSize,
): { page: number; pageCount: number; start: number; end: number };
//   - size "all": pageCount 1, page 1, start 0, end total.
//   - total 0:    pageCount 1, page 1, start 0, end 0.
//   - page clamped to [1, pageCount].

// Build the numbered-pager sequence: first + last, current ±1, "…" for gaps.
// Returns an ordered list of page numbers and gap markers.
export function pageWindow(
  page: number,
  pageCount: number,
): (number | "ellipsis")[];
//   e.g. pageWindow(6, 12) -> [1, "ellipsis", 5, 6, 7, "ellipsis", 12]
//        pageWindow(1, 3)  -> [1, 2, 3]
//        pageWindow(2, 1)  -> [1]
```

### 2. Page wiring — `apps/web/src/app/businesses/page.tsx`

- Read `size` via `parsePageSize(first(params.size))` and add it to the `current`
  filters object so it survives across pill links.
- After `listBusinessesRanked(...)` returns, compute
  `resolvePage(rows.length, first(params.page), size)` and render
  `rows.slice(start, end)` instead of `rows`.
- **Page-size selector**: a new pill row ("Per page  25  50  100  All") matching
  the existing Status/Town/Show rows. Each link is `hrefWith(current, { size, page: undefined })` — changing size drops `page`.
- **Numbered pager**: rendered below the list only when `size !== "all"` and
  `pageCount > 1`. Maps `pageWindow(page, pageCount)` to links via
  `hrefWith(current, { page: String(n) })`; renders `…` for `"ellipsis"`; the
  current page is highlighted and non-clickable; `‹`/`›` are disabled (rendered
  as plain spans) on the first/last page.
- **Count line** becomes a window: `Showing {start + 1}–{end} of {rows.length}
  {businesses} … ranked by search priority`, and falls back to the existing
  `{n} businesses` phrasing when `size === "all"`.
- **Filter links must reset paging.** The `hrefWith` calls that change a filter
  (status, town, tag, search submit, chains, tier4) pass `page: undefined`. The
  search `<form>` already navigates fresh via hidden inputs; ensure it does not
  carry `page` (omit a hidden `page` input).

## Edge cases

- **Empty result** (`rows.length === 0`): the existing "No businesses match these
  filters" message renders; no pager. `resolvePage` returns a valid 1-of-1
  window, so no crash.
- **Out-of-range `page`** (e.g. deep link after filtering shrinks the set):
  clamped to the last page.
- **`size=all`**: pager hidden, every row rendered (today's behavior preserved).
- The query's `limit: 5000` safety cap is unchanged — pagination is a view over
  whatever the query returns.

## Testing

Unit tests in `apps/web/src/lib/pagination.test.ts` (Vitest, newly wired into the
web workspace per unit 1):

- `parsePageSize`: each valid value, missing → 50, garbage → 50, `"all"`.
- `resolvePage`: first/middle/last page slice bounds; clamp above `pageCount`;
  clamp below 1; `total = 0`; `size = "all"` returns the whole range.
- `pageWindow`: few pages (no ellipsis), current near start, middle (two
  ellipses), near end; `pageCount` 1.

No rendering test for the page itself — the arithmetic is the part that can be
wrong, and it lives in the pure helper.

## Out of scope

- No infinite scroll / "load more" (would require client state; rejected during
  brainstorming).
- No change to `listBusinessesRanked` or any DB-package code.
- No per-user persistence of page size (URL param only; no cookie).
