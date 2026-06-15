# Businesses Directory Pagination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add numbered pagination (with a 25/50/100/All page-size selector) to the `/businesses` directory so the data layer returns only the requested page, not the whole region.

**Architecture:** Pagination lives in the query layer (approach "B1", deliberately flagged for rebuild review in the spec). `listBusinessesRanked` still ranks/counts the full filtered set in memory (tier comes from `categories.json`, not SQL), then slices to the requested page via a pure `resolvePage` helper and returns `rows` (the page) plus `matched`/`page`/`pageCount`. Pagination params are optional, so the agents' `list_businesses` tool is unaffected. The web page renders the returned page and a numbered pager; view-only helpers (`parsePageSize`, `pageWindow`) live in `apps/web/src/lib`.

**Tech Stack:** TypeScript, Next.js 16 (React server component), Drizzle/SQLite, Vitest, npm workspaces.

**Spec:** `docs/superpowers/specs/2026-06-15-businesses-pagination-design.md` (read the ⚠️ rebuild-review callout at the top — B1 limits payload, not per-request server work).

---

## File Structure

- **Create** `packages/db/src/pagination.ts` — pure `resolvePage(matched, page, pageSize)` slice math. Lives in the db package because the query consumes it and the package already has a Vitest suite.
- **Create** `packages/db/src/pagination.test.ts` — unit tests for `resolvePage`.
- **Modify** `packages/db/src/queries.ts` — extend `RankedBusinessFilters` (`page`/`pageSize`) and `RankedBusinessList` (`matched`/`page`/`pageCount`); slice in `listBusinessesRanked`.
- **Modify** `packages/db/src/queries.test.ts` — add a `listBusinessesRanked pagination` describe.
- **Create** `apps/web/src/lib/pagination.ts` — view helpers `PAGE_SIZES`, `parsePageSize`, `pageWindow`.
- **Create** `apps/web/src/lib/pagination.test.ts` — unit tests for the view helpers.
- **Modify** `apps/web/package.json` — add `vitest` devDep + `test` script.
- **Modify** `package.json` (root) — run both workspaces' tests.
- **Modify** `apps/web/src/app/businesses/page.tsx` — page-size selector, numbered pager, windowed count line, `size` carried on links, `page` reset on filter/size change.

Note: `packages/db/src/index.ts` re-exports `./queries` and uses `export *`, so the new `RankedBusinessFilters`/`RankedBusinessList` fields are exported automatically. No index change needed. (Adding `export * from "./pagination"` is optional — `resolvePage` is only used internally by the query — so this plan does NOT add it, to keep the public surface minimal.)

---

## Task 1: `resolvePage` slice helper (db package)

**Files:**
- Create: `packages/db/src/pagination.ts`
- Test: `packages/db/src/pagination.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/db/src/pagination.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolvePage } from "./pagination";

describe("resolvePage", () => {
  it("returns the first-page window", () => {
    expect(resolvePage(10, 1, 4)).toEqual({ page: 1, pageCount: 3, start: 0, end: 4 });
  });

  it("returns a middle-page window", () => {
    expect(resolvePage(10, 2, 4)).toEqual({ page: 2, pageCount: 3, start: 4, end: 8 });
  });

  it("trims the partial last page to `matched`", () => {
    expect(resolvePage(10, 3, 4)).toEqual({ page: 3, pageCount: 3, start: 8, end: 10 });
  });

  it("clamps a too-high page down to the last page", () => {
    expect(resolvePage(10, 99, 4)).toEqual({ page: 3, pageCount: 3, start: 8, end: 10 });
  });

  it("clamps page below 1 up to 1", () => {
    expect(resolvePage(10, 0, 4)).toEqual({ page: 1, pageCount: 3, start: 0, end: 4 });
  });

  it("treats an empty set as a single empty page", () => {
    expect(resolvePage(0, 1, 4)).toEqual({ page: 1, pageCount: 1, start: 0, end: 0 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm -w @localfinds/db run test -- pagination`
Expected: FAIL — Vitest cannot resolve `./pagination` ("Failed to load url ./pagination" / module not found).

- [ ] **Step 3: Write the implementation**

Create `packages/db/src/pagination.ts`:

```ts
// Pure pagination arithmetic for the ranked business directory. The ranked list
// is built and sorted in memory (tier comes from categories.json, not SQL), so
// paging is a slice of that sorted array. This turns a requested page into a
// clamped window over `matched` items.

export interface PageWindow {
  /** Clamped, 1-indexed current page. */
  page: number;
  /** Total number of pages (always >= 1). */
  pageCount: number;
  /** Slice start index, inclusive. */
  start: number;
  /** Slice end index, exclusive. */
  end: number;
}

// `matched` = number of items being paged. `pageSize` must be > 0.
export function resolvePage(
  matched: number,
  page: number,
  pageSize: number,
): PageWindow {
  const pageCount = Math.max(1, Math.ceil(matched / pageSize));
  const clamped = Math.min(Math.max(Math.trunc(page) || 1, 1), pageCount);
  const start = (clamped - 1) * pageSize;
  const end = Math.min(start + pageSize, matched);
  return { page: clamped, pageCount, start, end };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm -w @localfinds/db run test -- pagination`
Expected: PASS — 6 passing.

- [ ] **Step 5: Commit** (run as two separate Bash calls)

```bash
git add packages/db/src/pagination.ts packages/db/src/pagination.test.ts
```
```bash
git commit -m "feat(db): resolvePage pure pagination helper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Paginate `listBusinessesRanked` (db package)

**Files:**
- Modify: `packages/db/src/queries.ts`
- Test: `packages/db/src/queries.test.ts`

- [ ] **Step 1: Write the failing test**

Append this describe block to the END of `packages/db/src/queries.test.ts` (after the `dedupeBusinesses` describe, before EOF):

```ts
describe("listBusinessesRanked pagination", () => {
  it("returns only the requested page plus matched/pageCount, full set when unpaged", () => {
    const cfgDir = path.join(tmp, "config");
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(
      path.join(cfgDir, "categories.json"),
      JSON.stringify({
        default_tier: 3,
        hide_in_directory: { tier4: false, chains: false },
        tiers: {},
      }),
    );
    for (const n of ["A", "B", "C", "D", "E"]) {
      q.upsertBusiness({
        osmId: `node/pg-${n}`,
        name: `Pager ${n}`,
        town: "Pager",
        addedBy: "test",
      });
    }

    // Unpaged (no pageSize): the full sorted set, page/pageCount default to 1.
    const all = q.listBusinessesRanked({ town: "Pager" });
    expect(all.rows.map((r) => r.business.name)).toEqual([
      "Pager A",
      "Pager B",
      "Pager C",
      "Pager D",
      "Pager E",
    ]);
    expect(all.matched).toBe(5);
    expect(all.page).toBe(1);
    expect(all.pageCount).toBe(1);

    // Page 2 of size 2 -> third + fourth rows; matched/pageCount span the full set.
    const p2 = q.listBusinessesRanked({ town: "Pager", page: 2, pageSize: 2 });
    expect(p2.rows.map((r) => r.business.name)).toEqual(["Pager C", "Pager D"]);
    expect(p2.matched).toBe(5);
    expect(p2.pageCount).toBe(3);
    expect(p2.page).toBe(2);

    // Out-of-range page clamps to the last (partial) page.
    const last = q.listBusinessesRanked({ town: "Pager", page: 99, pageSize: 2 });
    expect(last.page).toBe(3);
    expect(last.rows.map((r) => r.business.name)).toEqual(["Pager E"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm -w @localfinds/db run test -- queries`
Expected: FAIL — the new test fails: `all.matched` is `undefined` (expected 5), and `p2.rows` returns all 5 names because `pageSize` is ignored. Existing tests still pass.

- [ ] **Step 3: Add the import**

In `packages/db/src/queries.ts`, add the import near the other local imports (the file imports `readCategoryConfig` from `./config`; add this line beside it):

```ts
import { resolvePage } from "./pagination";
```

- [ ] **Step 4: Extend the filter + result interfaces**

In `packages/db/src/queries.ts`, replace this block:

```ts
export interface RankedBusinessFilters extends BusinessFilters {
  /** Drop rows whose tier is worse (numerically greater) than this. */
  maxTier?: number;
  /** Include Tier-4 ("not a business") rows. Defaults to the config's hide rule. */
  includeTier4?: boolean;
  /** Include chains. Defaults to the config's hide rule. */
  includeChains?: boolean;
}

export interface RankedBusinessList {
  rows: RankedBusiness[];
  /** Total rows matching the DB filters, before tier/chain visibility. */
  total: number;
  tier4Count: number;
  chainCount: number;
}
```

with:

```ts
export interface RankedBusinessFilters extends BusinessFilters {
  /** Drop rows whose tier is worse (numerically greater) than this. */
  maxTier?: number;
  /** Include Tier-4 ("not a business") rows. Defaults to the config's hide rule. */
  includeTier4?: boolean;
  /** Include chains. Defaults to the config's hide rule. */
  includeChains?: boolean;
  /** 1-indexed page (default 1). Ignored unless `pageSize` is set. */
  page?: number;
  /** Positive page size. Omit (or <= 0) to return the full ranked set. */
  pageSize?: number;
}

export interface RankedBusinessList {
  /** The current page of ranked rows (or the full set when not paging). */
  rows: RankedBusiness[];
  /** Total rows matching the DB filters, before tier/chain visibility. */
  total: number;
  /** Rows after tier4/chain visibility — the set being paged. */
  matched: number;
  /** Clamped current page (1 when not paging). */
  page: number;
  /** Total pages (1 when not paging, or when `matched` is 0). */
  pageCount: number;
  tier4Count: number;
  chainCount: number;
}
```

- [ ] **Step 5: Slice in `listBusinessesRanked`**

In `packages/db/src/queries.ts`, replace the tail of `listBusinessesRanked` — this block:

```ts
  const rows = annotated
    .filter(
      (a) =>
        (showTier4 || a.tier !== 4) &&
        (showChains || !a.isChain) &&
        (filters.maxTier == null || a.tier <= filters.maxTier),
    )
    .sort(
      (a, z) =>
        Number(a.isChain) - Number(z.isChain) ||
        a.tier - z.tier ||
        a.business.name.localeCompare(z.business.name),
    );

  return { rows, total: annotated.length, tier4Count, chainCount };
}
```

with:

```ts
  const visible = annotated
    .filter(
      (a) =>
        (showTier4 || a.tier !== 4) &&
        (showChains || !a.isChain) &&
        (filters.maxTier == null || a.tier <= filters.maxTier),
    )
    .sort(
      (a, z) =>
        Number(a.isChain) - Number(z.isChain) ||
        a.tier - z.tier ||
        a.business.name.localeCompare(z.business.name),
    );

  const matched = visible.length;
  let rows = visible;
  let page = 1;
  let pageCount = 1;
  if (filters.pageSize && filters.pageSize > 0) {
    const win = resolvePage(matched, filters.page ?? 1, filters.pageSize);
    page = win.page;
    pageCount = win.pageCount;
    rows = visible.slice(win.start, win.end);
  }

  return { rows, total: annotated.length, matched, page, pageCount, tier4Count, chainCount };
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm -w @localfinds/db run test -- queries`
Expected: PASS — the new pagination test passes and all pre-existing `queries.test.ts` tests still pass (the `listBusinessesRanked` default-visibility test relies on the unchanged `rows`/`total`/counts).

- [ ] **Step 7: Run the full db suite**

Run: `npm -w @localfinds/db run test`
Expected: PASS — entire db package green (confirms `resolvePage` + queries together).

- [ ] **Step 8: Commit** (run as two separate Bash calls)

```bash
git add packages/db/src/queries.ts packages/db/src/queries.test.ts
```
```bash
git commit -m "feat(db): listBusinessesRanked returns only the requested page

Optional page/pageSize slice the ranked set in memory after ranking and
counting; adds matched/page/pageCount to the result. Omitting the params
returns the full set, so the agents' list_businesses tool is unaffected.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Web view helpers + Vitest in the web workspace

**Files:**
- Modify: `apps/web/package.json`
- Modify: `package.json` (root)
- Create: `apps/web/src/lib/pagination.ts`
- Test: `apps/web/src/lib/pagination.test.ts`

- [ ] **Step 1: Add Vitest to the web workspace**

In `apps/web/package.json`, add a `test` script and the `vitest` devDependency.

Change the `scripts` block from:

```json
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start"
  },
```

to:

```json
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "test": "vitest run"
  },
```

And add `"vitest": "^3.2.0"` to the `devDependencies` block (alphabetical-ish; place after `"typescript": "^5.8.0"` — remember to add the trailing comma to the line above it):

```json
    "typescript": "^5.8.0",
    "vitest": "^3.2.0"
```

- [ ] **Step 2: Install so the web workspace resolves Vitest**

Run: `npm install`
Expected: completes without error (Vitest is already in the monorepo via `packages/db`; this links it for `apps/web`).

- [ ] **Step 3: Point the root `test` script at both workspaces**

In the root `package.json`, change:

```json
    "test": "npm -w @localfinds/db run test",
```

to:

```json
    "test": "npm -w @localfinds/db run test && npm -w @localfinds/web run test",
```

- [ ] **Step 4: Write the failing test**

Create `apps/web/src/lib/pagination.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { pageWindow, parsePageSize } from "./pagination";

describe("parsePageSize", () => {
  it("accepts the known sizes", () => {
    expect(parsePageSize("25")).toBe(25);
    expect(parsePageSize("50")).toBe(50);
    expect(parsePageSize("100")).toBe(100);
    expect(parsePageSize("all")).toBe("all");
  });

  it("defaults missing or invalid values to 50", () => {
    expect(parsePageSize(undefined)).toBe(50);
    expect(parsePageSize("")).toBe(50);
    expect(parsePageSize("17")).toBe(50);
    expect(parsePageSize("banana")).toBe(50);
  });
});

describe("pageWindow", () => {
  it("lists every page when there is no gap", () => {
    expect(pageWindow(1, 3)).toEqual([1, 2, 3]);
  });

  it("collapses both sides around a middle page", () => {
    expect(pageWindow(6, 12)).toEqual([1, "ellipsis", 5, 6, 7, "ellipsis", 12]);
  });

  it("collapses only the trailing gap near the start", () => {
    expect(pageWindow(2, 12)).toEqual([1, 2, 3, "ellipsis", 12]);
  });

  it("collapses only the leading gap near the end", () => {
    expect(pageWindow(11, 12)).toEqual([1, "ellipsis", 10, 11, 12]);
  });

  it("returns a single page for one or zero pages", () => {
    expect(pageWindow(1, 1)).toEqual([1]);
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `npm -w @localfinds/web run test -- pagination`
Expected: FAIL — Vitest cannot resolve `./pagination` (module not found).

- [ ] **Step 6: Write the implementation**

Create `apps/web/src/lib/pagination.ts`:

```ts
// View-side pagination helpers for the /businesses directory. The query layer
// (packages/db) owns the slice math; this owns the URL page-size vocabulary and
// the numbered-pager sequence.

export type PageSize = 25 | 50 | 100 | "all";

export const PAGE_SIZES: PageSize[] = [25, 50, 100, "all"];

export const DEFAULT_PAGE_SIZE = 50;

// Parse a raw ?size= value. Unknown/missing -> the default (50).
export function parsePageSize(raw: string | undefined): PageSize {
  if (raw === "all") return "all";
  const n = Number(raw);
  return n === 25 || n === 50 || n === 100 ? n : DEFAULT_PAGE_SIZE;
}

// Numbered-pager sequence: always first + last, the current page +/- 1, and an
// "ellipsis" marker wherever a run of pages is collapsed.
export function pageWindow(
  page: number,
  pageCount: number,
): (number | "ellipsis")[] {
  if (pageCount <= 1) return [1];

  const wanted = new Set<number>([1, pageCount, page - 1, page, page + 1]);
  const ordered = [...wanted]
    .filter((p) => p >= 1 && p <= pageCount)
    .sort((a, b) => a - b);

  const out: (number | "ellipsis")[] = [];
  let prev = 0;
  for (const p of ordered) {
    if (p - prev > 1) out.push("ellipsis");
    out.push(p);
    prev = p;
  }
  return out;
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npm -w @localfinds/web run test -- pagination`
Expected: PASS — parsePageSize + pageWindow suites green.

- [ ] **Step 8: Commit** (run as two separate Bash calls)

```bash
git add apps/web/package.json package.json package-lock.json apps/web/src/lib/pagination.ts apps/web/src/lib/pagination.test.ts
```
```bash
git commit -m "feat(web): pagination view helpers + Vitest in web workspace

parsePageSize (25/50/100/All, default 50) and pageWindow (numbered pager
with ellipsis). Wires Vitest into apps/web and the root test script.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Wire the `/businesses` page

**Files:**
- Modify: `apps/web/src/app/businesses/page.tsx`

No unit test (React server component); verified by typecheck + the full test suite + a manual click-through.

- [ ] **Step 1: Add the helper import**

In `apps/web/src/app/businesses/page.tsx`, after the `remark-gfm` import line:

```tsx
import remarkGfm from "remark-gfm";
```

add:

```tsx
import { PAGE_SIZES, pageWindow, parsePageSize } from "@/lib/pagination";
```

- [ ] **Step 2: Add `size` to the `Filters` type**

Replace:

```tsx
type Filters = {
  town?: string;
  status?: string;
  tag?: string;
  q?: string;
  tier4?: string;
  chains?: string;
};
```

with:

```tsx
type Filters = {
  town?: string;
  status?: string;
  tag?: string;
  q?: string;
  tier4?: string;
  chains?: string;
  size?: string;
};
```

- [ ] **Step 3: Parse size + page and add `size` to `current`**

Replace:

```tsx
  const tier4 = first(params.tier4);
  const chains = first(params.chains);
  const current: Filters = { town, status, tag, q, tier4, chains };
```

with:

```tsx
  const tier4 = first(params.tier4);
  const chains = first(params.chains);
  const size = parsePageSize(first(params.size));
  const pageReq = Math.max(1, Number.parseInt(first(params.page) ?? "", 10) || 1);
  // `size` rides along on filter/pager links; the default (50) stays implicit to
  // keep URLs clean. `page` is deliberately NOT in `current`, so every filter and
  // size link drops it (resetting to page 1); only the numbered pager re-adds it.
  const current: Filters = {
    town,
    status,
    tag,
    q,
    tier4,
    chains,
    size: size === 50 ? undefined : String(size),
  };
```

- [ ] **Step 4: Pass pagination to the query and compute `start`**

Replace:

```tsx
  const { rows, total, tier4Count, chainCount } = listBusinessesRanked({
    town,
    status,
    tag,
    q,
    limit: 5000,
    includeTier4: showTier4,
    includeChains: showChains,
  });
```

with:

```tsx
  const { rows, total, matched, page, pageCount, tier4Count, chainCount } =
    listBusinessesRanked({
      town,
      status,
      tag,
      q,
      limit: 5000,
      includeTier4: showTier4,
      includeChains: showChains,
      page: pageReq,
      pageSize: size === "all" ? undefined : size,
    });
  const start = size === "all" ? 0 : (page - 1) * size;
```

- [ ] **Step 5: Add the `size` hidden input to the search form**

Replace:

```tsx
          {chains && <input type="hidden" name="chains" value={chains} />}
          <input
            type="search"
            name="q"
```

with (note: no hidden `page` input — submitting search resets to page 1):

```tsx
          {chains && <input type="hidden" name="chains" value={chains} />}
          {current.size && <input type="hidden" name="size" value={current.size} />}
          <input
            type="search"
            name="q"
```

- [ ] **Step 6: Add the "Per page" selector row**

In the filter card, replace the chains/tier4 "Show" block:

```tsx
        {(chainCount > 0 || tier4Count > 0) && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-xs font-medium text-stone-500">Show</span>
            {chainCount > 0 && (
              <a
                href={hrefWith(current, { chains: showChains ? undefined : "1" })}
                className={pill(showChains)}
              >
                chains ({chainCount})
              </a>
            )}
            {tier4Count > 0 && (
              <a
                href={hrefWith(current, { tier4: showTier4 ? undefined : "1" })}
                className={pill(showTier4)}
              >
                excluded categories ({tier4Count})
              </a>
            )}
          </div>
        )}
```

with (adds the "Per page" row immediately after):

```tsx
        {(chainCount > 0 || tier4Count > 0) && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-xs font-medium text-stone-500">Show</span>
            {chainCount > 0 && (
              <a
                href={hrefWith(current, { chains: showChains ? undefined : "1" })}
                className={pill(showChains)}
              >
                chains ({chainCount})
              </a>
            )}
            {tier4Count > 0 && (
              <a
                href={hrefWith(current, { tier4: showTier4 ? undefined : "1" })}
                className={pill(showTier4)}
              >
                excluded categories ({tier4Count})
              </a>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs font-medium text-stone-500">Per page</span>
          {PAGE_SIZES.map((s) => (
            <a
              key={s}
              href={hrefWith(current, { size: s === 50 ? undefined : String(s) })}
              className={pill(size === s)}
            >
              {s === "all" ? "All" : s}
            </a>
          ))}
        </div>
```

- [ ] **Step 7: Make the count line a window**

Replace:

```tsx
      <p className="text-xs text-stone-500">
        {rows.length} {rows.length === 1 ? "business" : "businesses"}
        {hasFilters ? " matching filters" : ""}, ranked by search priority
      </p>
```

with:

```tsx
      <p className="text-xs text-stone-500">
        {size === "all" || matched === 0
          ? `${matched} ${matched === 1 ? "business" : "businesses"}`
          : `Showing ${start + 1}–${start + rows.length} of ${matched} businesses`}
        {hasFilters ? " matching filters" : ""}, ranked by search priority
      </p>
```

- [ ] **Step 8: Key the empty-list message off `matched`**

Replace:

```tsx
      {rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-stone-500">
          No businesses match these filters.
        </p>
      ) : (
```

with:

```tsx
      {matched === 0 ? (
        <p className="py-8 text-center text-sm text-stone-500">
          No businesses match these filters.
        </p>
      ) : (
```

- [ ] **Step 9: Add the numbered pager**

Find the end of the list block — the closing of the cards `<div>` followed by the page's outer closing `</div>`:

```tsx
        </div>
      )}
    </div>
  );
}
```

Replace it with (inserts the `<nav>` pager between the list block and the outer close):

```tsx
        </div>
      )}

      {size !== "all" && pageCount > 1 && (
        <nav className="flex flex-wrap items-center justify-center gap-1.5 pt-2">
          {page > 1 ? (
            <a href={hrefWith(current, { page: String(page - 1) })} className={pill(false)}>
              ‹
            </a>
          ) : (
            <span className={`${pill(false)} opacity-40`}>‹</span>
          )}
          {pageWindow(page, pageCount).map((p, i) =>
            p === "ellipsis" ? (
              <span key={`ellipsis-${i}`} className="px-1 text-xs text-stone-400">
                …
              </span>
            ) : p === page ? (
              <span key={p} className={pill(true)} aria-current="page">
                {p}
              </span>
            ) : (
              <a key={p} href={hrefWith(current, { page: String(p) })} className={pill(false)}>
                {p}
              </a>
            ),
          )}
          {page < pageCount ? (
            <a href={hrefWith(current, { page: String(page + 1) })} className={pill(false)}>
              ›
            </a>
          ) : (
            <span className={`${pill(false)} opacity-40`}>›</span>
          )}
        </nav>
      )}
    </div>
  );
}
```

- [ ] **Step 10: Typecheck the web app**

Run: `npx tsc -p apps/web/tsconfig.json --noEmit`
Expected: no errors (confirms the new `matched`/`page`/`pageCount` destructure and `@/lib/pagination` import typecheck).

- [ ] **Step 11: Run the full test suite**

Run: `npm test`
Expected: PASS — both `@localfinds/db` and `@localfinds/web` suites green.

- [ ] **Step 12: Manual verification (browser)**

Run: `npm run dev`, open `http://localhost:3000/businesses`. Confirm:
- Default shows 50 cards (or fewer) with `Showing 1–50 of N businesses` and a numbered pager when N > 50.
- Clicking page `2` advances the window and the URL gains `?page=2`.
- Clicking `All` shows everything and hides the pager; `25`/`100` change the window.
- Applying a filter (e.g. a Town pill) while on page 2 resets to page 1 (no `page` in the URL).
- A search submit keeps the chosen `size` but resets the page.

Stop the dev server when done (Ctrl-C).

- [ ] **Step 13: Commit** (run as two separate Bash calls)

```bash
git add apps/web/src/app/businesses/page.tsx
```
```bash
git commit -m "feat(web): paginate the businesses directory

Adds a 25/50/100/All page-size selector and a numbered pager with
ellipsis; the page renders only the page returned by listBusinessesRanked.
Filter and size changes reset to page 1; size persists across them.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review notes (for the implementer)

- **Spec coverage:** B1 query slice (Task 2), `resolvePage` helper (Task 1), `25/50/100/All` selector + numbered ellipsis pager (Tasks 3–4), `matched`/`page`/`pageCount` return fields (Task 2), filter/size reset to page 1 (Task 4 steps 3/5/6), out-of-range clamp (Tasks 1–2), `size=all` hides pager (Task 4 step 9), agent tool unaffected (Task 2 — params optional, backward-compat asserted in test), web Vitest prerequisite (Task 3). All present.
- **Type names are consistent across tasks:** `resolvePage` / `PageWindow` (db), `RankedBusinessFilters.page`/`.pageSize`, `RankedBusinessList.matched`/`.page`/`.pageCount`, `parsePageSize` / `pageWindow` / `PAGE_SIZES` / `PageSize` (web).
- **The `categories.json` written in Task 2's test** sets `hide_in_directory` false and `default_tier: 3` so all five `Pager *` rows are visible at the same tier and sort by name (A–E) — making the slice assertions deterministic. It's appended last so it doesn't perturb earlier tests.
