# Businesses Page Table Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `/businesses` accordion with a paginated, sortable Tier/Name/Kind/Town table plus a `/businesses/[id]` detail page, with column sorting handled in the db query layer (where it must run, before pagination).

**Architecture:** A pure `sortRankedBusinesses` helper in `packages/db` owns all ordering — its `undefined`-sort branch reproduces today's search-priority ranking byte-for-byte (the agents' `list_businesses` tool depends on it), and explicit sorts override it. `listBusinessesRanked` calls it before slicing for the page and gains `sort`/`dir` filters; a new `getBusinessById` backs the detail page. The page rewrites the accordion as a table and threads `sort`/`dir` through the URL alongside the existing filters and pager. Server components, `force-dynamic`, all state in the URL.

**Tech Stack:** Next.js (App Router, RSC), Drizzle ORM over SQLite, Tailwind CSS, Vitest, `react-markdown` + `remark-gfm`.

**Spec:** `docs/superpowers/specs/2026-06-16-businesses-page-table-redesign-design.md`

---

## File Structure

| File | Responsibility |
|------|----------------|
| `packages/db/src/business-sort.ts` | New: `BusinessSort`/`SortDir` types, `sortRankedBusinesses`, `parseBusinessSort`/`parseDir` |
| `packages/db/src/business-sort.test.ts` | New: unit tests for the comparator + parsers |
| `packages/db/src/index.ts` | Export the new module |
| `packages/db/src/queries.ts` | `listBusinessesRanked` gains `sort`/`dir`; add `getBusinessById` |
| `packages/db/src/queries.test.ts` | New block: sort wiring + `getBusinessById` |
| `apps/web/src/app/businesses/page.tsx` | Rewrite accordion → sortable table |
| `apps/web/src/app/businesses/[id]/page.tsx` | New: business detail page |

Conventions (already in the repo):
- db unit tests: `import { describe, expect, it } from "vitest"`; the integration suite is `packages/db/src/queries.test.ts` (throwaway db in `beforeAll`, module exposed as `q`).
- The page mirrors the current `businesses/page.tsx` filter idioms (`first`, `hrefWith`, `pill`) and the just-shipped `/sources` table idioms (sortable `<th>` with `aria-sort` + `scope="col"`, `Number(idParam)` 404 guard).

> **Merge note:** `queries.ts`/`queries.test.ts` are also edited by the open `/sources` PR. Keep `getBusinessById` next to `listBusinessesRanked` and the new test in its own appended block, away from the sources additions near `listSources`, so the eventual merge is trivial.

---

## Task 1: `business-sort.ts` — pure ordering helper + parsers

**Files:**
- Create: `packages/db/src/business-sort.ts`
- Test: `packages/db/src/business-sort.test.ts`
- Modify: `packages/db/src/index.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/db/src/business-sort.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Business } from "./schema";
import {
  parseBusinessSort,
  parseDir,
  sortRankedBusinesses,
} from "./business-sort";

// Build a RankedBusiness; only the fields the comparator reads need to vary.
function rb(
  over: Partial<Business> & { tier?: number; isChain?: boolean },
): { business: Business; tier: number; isChain: boolean } {
  const { tier = 1, isChain = false, ...bo } = over;
  const business: Business = {
    id: 1,
    osmId: "node/1",
    name: "Business",
    kind: null,
    tags: [],
    address: null,
    town: null,
    lat: null,
    lng: null,
    website: null,
    phone: null,
    brand: null,
    status: "active",
    notesPath: null,
    addedBy: "test",
    discoveredAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    duplicateOf: null,
    ...bo,
  };
  return { business, tier, isChain };
}

const names = (rows: ReturnType<typeof rb>[]) => rows.map((r) => r.business.name);

describe("sortRankedBusinesses — default ranking", () => {
  it("orders chains last, then by tier, then by name", () => {
    const rows = [
      rb({ name: "Zeta", tier: 1 }),
      rb({ name: "Alpha", tier: 2 }),
      rb({ name: "Beta", tier: 1 }),
      rb({ name: "AAA Chain", tier: 1, isChain: true }),
    ];
    expect(names(sortRankedBusinesses(rows, undefined, "asc"))).toEqual([
      "Beta",
      "Zeta",
      "Alpha",
      "AAA Chain",
    ]);
  });
});

describe("sortRankedBusinesses — explicit columns", () => {
  it("sorts by name ascending and descending", () => {
    const rows = [rb({ name: "Beta" }), rb({ name: "alpha" }), rb({ name: "Gamma" })];
    expect(names(sortRankedBusinesses(rows, "name", "asc"))).toEqual(["alpha", "Beta", "Gamma"]);
    expect(names(sortRankedBusinesses(rows, "name", "desc"))).toEqual(["Gamma", "Beta", "alpha"]);
  });

  it("sorts by tier with a name tiebreak", () => {
    const rows = [
      rb({ name: "B", tier: 2 }),
      rb({ name: "A", tier: 2 }),
      rb({ name: "C", tier: 1 }),
    ];
    expect(names(sortRankedBusinesses(rows, "tier", "asc"))).toEqual(["C", "A", "B"]);
  });

  it("puts null town last in both directions", () => {
    const rows = [
      rb({ name: "HasTown", town: "Rockland" }),
      rb({ name: "NoTown", town: null }),
      rb({ name: "AlsoTown", town: "Camden" }),
    ];
    expect(names(sortRankedBusinesses(rows, "town", "asc"))).toEqual(["AlsoTown", "HasTown", "NoTown"]);
    expect(names(sortRankedBusinesses(rows, "town", "desc"))).toEqual(["HasTown", "AlsoTown", "NoTown"]);
  });

  it("does not mutate the input", () => {
    const rows = [rb({ name: "B" }), rb({ name: "A" })];
    sortRankedBusinesses(rows, "name", "asc");
    expect(names(rows)).toEqual(["B", "A"]);
  });
});

describe("parsers", () => {
  it("parseBusinessSort accepts known keys, else undefined", () => {
    expect(parseBusinessSort("town")).toBe("town");
    expect(parseBusinessSort("name")).toBe("name");
    expect(parseBusinessSort("bogus")).toBeUndefined();
    expect(parseBusinessSort(undefined)).toBeUndefined();
  });

  it("parseDir defaults to asc", () => {
    expect(parseDir("desc")).toBe("desc");
    expect(parseDir("asc")).toBe("asc");
    expect(parseDir(undefined)).toBe("asc");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm -w @localfinds/db run test -- business-sort.test.ts`
Expected: FAIL — cannot resolve `./business-sort`.

- [ ] **Step 3: Implement the helper**

Create `packages/db/src/business-sort.ts`:

```ts
// Ordering for the /businesses directory. The default (undefined sort) is the
// search-priority ranking — chains last, then tier, then name — shared by the
// directory page and the agents' list_businesses tool, so it must not drift.
// Any explicit sort overrides it. This lives in packages/db (not the web app)
// because sorting must run before pagination, which happens in
// listBusinessesRanked. The RankedBusiness import is type-only (erased), so
// there is no runtime import cycle with queries.ts.
import type { RankedBusiness } from "./queries";

export type BusinessSort = "tier" | "name" | "kind" | "town";
export type SortDir = "asc" | "desc";

const SORT_KEYS: BusinessSort[] = ["tier", "name", "kind", "town"];

// Default ranking, byte-for-byte identical to the prior inline comparator.
function rankCompare(a: RankedBusiness, z: RankedBusiness): number {
  return (
    Number(a.isChain) - Number(z.isChain) ||
    a.tier - z.tier ||
    a.business.name.localeCompare(z.business.name)
  );
}

export function sortRankedBusinesses(
  rows: RankedBusiness[],
  sort: BusinessSort | undefined,
  dir: SortDir,
): RankedBusiness[] {
  if (sort === undefined) return [...rows].sort(rankCompare);

  const factor = dir === "asc" ? 1 : -1;
  const valueOf = (r: RankedBusiness): string | number | null => {
    switch (sort) {
      case "tier":
        return r.tier;
      case "name":
        return r.business.name;
      case "kind":
        return r.business.kind;
      case "town":
        return r.business.town;
    }
  };

  return [...rows].sort((a, z) => {
    const av = valueOf(a);
    const bv = valueOf(z);
    // Nulls (missing kind/town) sort last, independent of direction.
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    const cmp =
      typeof av === "number" && typeof bv === "number"
        ? av - bv
        : String(av).localeCompare(String(bv));
    // Apply direction, then a stable name tiebreak.
    return cmp * factor || a.business.name.localeCompare(z.business.name);
  });
}

export function parseBusinessSort(raw: string | undefined): BusinessSort | undefined {
  return SORT_KEYS.includes(raw as BusinessSort) ? (raw as BusinessSort) : undefined;
}

export function parseDir(raw: string | undefined): SortDir {
  return raw === "desc" ? "desc" : "asc";
}
```

- [ ] **Step 4: Export the module**

In `packages/db/src/index.ts`, add a line after `export * from "./business-dedupe";`:

```ts
export * from "./business-sort";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm -w @localfinds/db run test -- business-sort.test.ts`
Expected: PASS — all describe blocks green.

- [ ] **Step 6: Commit** (two separate Bash calls — never combine `git add` and `git commit`)

```bash
git add packages/db/src/business-sort.ts packages/db/src/business-sort.test.ts packages/db/src/index.ts
```
```bash
git commit -m "feat(db): add sortRankedBusinesses ordering helper for /businesses

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Wire sorting into `listBusinessesRanked` + add `getBusinessById`

**Files:**
- Modify: `packages/db/src/queries.ts`
- Test: `packages/db/src/queries.test.ts` (append a new `describe` block)

- [ ] **Step 1: Write the failing tests**

Append to `packages/db/src/queries.test.ts` (module exposed as `q`):

```ts
describe("listBusinessesRanked sort + getBusinessById", () => {
  it("getBusinessById returns a row or undefined", () => {
    const { id } = q.upsertBusiness({
      osmId: "node/bz-1",
      name: "BizById",
      town: "Rockland",
      addedBy: "test",
    });
    expect(q.getBusinessById(id)?.name).toBe("BizById");
    expect(q.getBusinessById(999_999)).toBeUndefined();
  });

  it("sort=name reorders relative to the default ranking", () => {
    q.upsertBusiness({ osmId: "node/sz-z", name: "Sortby ZZZ", kind: "amenity=cafe", town: "SortTown", addedBy: "test" });
    q.upsertBusiness({ osmId: "node/sz-a", name: "Sortby AAA", kind: "amenity=cafe", town: "SortTown", addedBy: "test" });
    const opts = { town: "SortTown", includeTier4: true } as const;
    const asc = q.listBusinessesRanked({ ...opts, sort: "name", dir: "asc" }).rows.map((r) => r.business.name);
    const desc = q.listBusinessesRanked({ ...opts, sort: "name", dir: "desc" }).rows.map((r) => r.business.name);
    expect(asc).toEqual(["Sortby AAA", "Sortby ZZZ"]);
    expect(desc).toEqual(["Sortby ZZZ", "Sortby AAA"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm -w @localfinds/db run test -- queries.test.ts`
Expected: FAIL — `q.getBusinessById is not a function`; the `sort`/`dir` options won't typecheck/order yet.

- [ ] **Step 3: Add the import**

At the top of `packages/db/src/queries.ts`, after the existing `./business-dedupe` import block (around line 10), add:

```ts
import {
  type BusinessSort,
  type SortDir,
  sortRankedBusinesses,
} from "./business-sort";
```

- [ ] **Step 4: Extend `RankedBusinessFilters`**

In `packages/db/src/queries.ts`, add two fields to the `RankedBusinessFilters` interface (after `pageSize?: number;`):

```ts
  /** Column sort. Omit for the default search-priority ranking. */
  sort?: BusinessSort;
  /** Sort direction (default "asc"). Ignored when `sort` is omitted. */
  dir?: SortDir;
```

- [ ] **Step 5: Route the sort through `listBusinessesRanked`**

In `listBusinessesRanked`, replace the `visible` declaration that currently filters AND sorts inline:

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
```

with a filter-only `visible` followed by a sorted `ordered`:

```ts
  const visible = annotated.filter(
    (a) =>
      (showTier4 || a.tier !== 4) &&
      (showChains || !a.isChain) &&
      (filters.maxTier == null || a.tier <= filters.maxTier),
  );
  const ordered = sortRankedBusinesses(visible, filters.sort, filters.dir ?? "asc");
```

Then update the three lines below that referenced `visible` to use `ordered`:

```ts
  const matched = ordered.length;
  let rows = ordered;
  let page = 1;
  let pageCount = 1;
  if (filters.pageSize && filters.pageSize > 0) {
    const win = resolvePage(matched, filters.page ?? 1, filters.pageSize);
    page = win.page;
    pageCount = win.pageCount;
    rows = ordered.slice(win.start, win.end);
  }
```

(With no `sort`, `sortRankedBusinesses` applies `rankCompare`, so output is identical to today.)

- [ ] **Step 6: Add `getBusinessById`**

In `packages/db/src/queries.ts`, immediately after the `listBusinessesRanked` function's closing brace (before the `MapPin` interface), add:

```ts
export function getBusinessById(id: number): Business | undefined {
  return db().select().from(businesses).where(eq(businesses.id, id)).get();
}
```

(`Business`, `db`, `eq`, and `businesses` are already imported at the top of the file. Verify before assuming.)

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm -w @localfinds/db run test -- queries.test.ts`
Expected: PASS — full `queries.test.ts` suite green, including the new block.

- [ ] **Step 8: Commit** (two separate Bash calls)

```bash
git add packages/db/src/queries.ts packages/db/src/queries.test.ts
```
```bash
git commit -m "feat(db): sort param for listBusinessesRanked + getBusinessById

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Rewrite `/businesses` as a sortable table

**Files:**
- Modify: `apps/web/src/app/businesses/page.tsx` (full rewrite)

Server component (no unit test, matching the repo). Verification is a typecheck; do NOT start the dev server (the controller runs consolidated browser verification after Task 4).

- [ ] **Step 1: Replace the page**

Overwrite `apps/web/src/app/businesses/page.tsx` with EXACTLY:

```tsx
import {
  type Business,
  type BusinessSort,
  type SortDir,
  listBusinessTowns,
  listBusinessesRanked,
  parseBusinessSort,
  parseDir,
  readCategoryConfig,
} from "@localfinds/db";
import Link from "next/link";
import { PAGE_SIZES, pageWindow, parsePageSize } from "@/lib/pagination";

export const dynamic = "force-dynamic";

const STATUSES = ["active", "closed", "unknown"] as const;

const STATUS_STYLE: Record<string, string> = {
  active: "bg-green-100 text-green-800",
  closed: "bg-red-100 text-red-800",
  unknown: "bg-stone-200 text-stone-600",
};

const TIER_STYLE: Record<number, string> = {
  1: "bg-emerald-100 text-emerald-800",
  2: "bg-sky-100 text-sky-800",
  3: "bg-stone-100 text-stone-600",
  4: "bg-stone-100 text-stone-400",
};

const COLUMNS: { key: BusinessSort; label: string }[] = [
  { key: "tier", label: "Tier" },
  { key: "name", label: "Name" },
  { key: "kind", label: "Kind" },
  { key: "town", label: "Town" },
];

type Filters = {
  town?: string;
  status?: string;
  tag?: string;
  q?: string;
  tier4?: string;
  chains?: string;
  size?: string;
  page?: string;
  sort?: string;
  dir?: string;
};

// Next.js delivers string[] for a repeated query key (?q=a&q=b); take the first.
function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function hrefWith(current: Filters, patch: Filters): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...current, ...patch })) {
    if (v) params.set(k, v);
  }
  const qs = params.toString();
  return qs ? `/businesses?${qs}` : "/businesses";
}

function pill(active: boolean): string {
  return `rounded px-2 py-0.5 text-xs ${
    active ? "bg-stone-800 text-white" : "bg-stone-100 text-stone-600 hover:bg-stone-200"
  }`;
}

export default async function BusinessesPage({
  searchParams,
}: {
  searchParams: Promise<Filters & Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const town = first(params.town) || undefined;
  const statusRaw = first(params.status);
  const status = STATUSES.includes(statusRaw as (typeof STATUSES)[number])
    ? (statusRaw as Business["status"])
    : undefined;
  const tag = first(params.tag) || undefined;
  const q = first(params.q) || undefined;
  const tier4 = first(params.tier4);
  const chains = first(params.chains);
  const size = parsePageSize(first(params.size));
  const pageReq = Math.max(1, Number.parseInt(first(params.page) ?? "", 10) || 1);
  const sort = parseBusinessSort(first(params.sort));
  const dir = parseDir(first(params.dir));
  // `size`/`sort`/`dir` ride along on filter/pager links; their defaults
  // (50 / ranking / asc) stay implicit to keep URLs clean. `page` is
  // deliberately NOT in `current`, so every filter, size, and sort link drops
  // it (resetting to page 1); only the numbered pager re-adds it.
  const current: Filters = {
    town,
    status,
    tag,
    q,
    tier4,
    chains,
    size: size === 50 ? undefined : String(size),
    sort: sort ?? undefined,
    dir: dir === "asc" ? undefined : dir,
  };

  const cfg = readCategoryConfig();
  const showTier4 = tier4 === "1" || !cfg.hideInDirectory.tier4;
  const showChains = chains === "1" || !cfg.hideInDirectory.chains;

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
      sort,
      dir,
    });
  const start = size === "all" ? 0 : (page - 1) * size;
  const towns = listBusinessTowns();
  const hasFilters = Boolean(town || status || tag || q);

  const orderLabel = !sort
    ? "ranked by search priority"
    : sort === "tier"
      ? `sorted by tier (${dir === "asc" ? "low–high" : "high–low"})`
      : `sorted by ${sort} (${dir === "asc" ? "A–Z" : "Z–A"})`;

  if (total === 0 && !hasFilters) {
    return (
      <p className="py-12 text-center text-sm text-stone-500">
        No businesses yet. The cartographer agent populates this from
        OpenStreetMap on its first run (run{" "}
        <code className="rounded bg-stone-100 px-1">
          npm run agent -- cartographer
        </code>
        ).
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 rounded-lg border border-stone-200 bg-white p-3">
        <form action="/businesses" className="flex gap-2">
          {town && <input type="hidden" name="town" value={town} />}
          {status && <input type="hidden" name="status" value={status} />}
          {tag && <input type="hidden" name="tag" value={tag} />}
          {tier4 && <input type="hidden" name="tier4" value={tier4} />}
          {chains && <input type="hidden" name="chains" value={chains} />}
          {current.size && <input type="hidden" name="size" value={current.size} />}
          {current.sort && <input type="hidden" name="sort" value={current.sort} />}
          {current.dir && <input type="hidden" name="dir" value={current.dir} />}
          <input
            type="search"
            name="q"
            defaultValue={q ?? ""}
            placeholder="Search by name…"
            className="flex-1 rounded border border-stone-300 px-2 py-1 text-sm"
          />
          <button
            type="submit"
            className="rounded bg-stone-800 px-3 py-1 text-sm text-white"
          >
            Search
          </button>
        </form>

        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs font-medium text-stone-500">Status</span>
          <a href={hrefWith(current, { status: undefined })} className={pill(!status)}>
            all
          </a>
          {STATUSES.map((s) => (
            <a key={s} href={hrefWith(current, { status: s })} className={pill(status === s)}>
              {s}
            </a>
          ))}
        </div>

        {towns.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-xs font-medium text-stone-500">Town</span>
            <a href={hrefWith(current, { town: undefined })} className={pill(!town)}>
              all
            </a>
            {towns.map((t) => (
              <a
                key={t.town}
                href={hrefWith(current, { town: t.town })}
                className={pill(town === t.town)}
              >
                {t.town} <span className="opacity-60">{t.n}</span>
              </a>
            ))}
          </div>
        )}

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

        {tag && (
          <div className="text-xs text-stone-500">
            Tag: <span className="font-medium">{tag}</span>{" "}
            <a href={hrefWith(current, { tag: undefined })} className="text-blue-700 hover:underline">
              clear
            </a>
          </div>
        )}
      </div>

      <p className="text-xs text-stone-500">
        {size === "all" || matched === 0
          ? `${matched} ${matched === 1 ? "business" : "businesses"}`
          : `Showing ${start + 1}–${start + rows.length} of ${matched} businesses`}
        {hasFilters ? " matching filters" : ""}, {orderLabel}
      </p>

      {matched === 0 ? (
        <p className="py-8 text-center text-sm text-stone-500">
          No businesses match these filters.
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-stone-200 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-stone-200 text-xs text-stone-500">
                {COLUMNS.map((col) => {
                  const isActive = sort === col.key;
                  const nextDir: SortDir = isActive && dir === "asc" ? "desc" : "asc";
                  return (
                    <th
                      key={col.key}
                      scope="col"
                      aria-sort={
                        isActive ? (dir === "asc" ? "ascending" : "descending") : "none"
                      }
                      className="px-3 py-2 text-left font-medium"
                    >
                      <a
                        href={hrefWith(current, {
                          sort: col.key,
                          dir: nextDir === "asc" ? undefined : nextDir,
                        })}
                        className="inline-flex items-center gap-1 hover:text-stone-900"
                      >
                        {col.label}
                        {isActive && <span aria-hidden>{dir === "asc" ? "▲" : "▼"}</span>}
                      </a>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map(({ business: b, tier, isChain }) => (
                <tr key={b.id} className="border-b border-stone-100 last:border-0">
                  <td className="px-3 py-2">
                    <span
                      className={`rounded px-1.5 py-0.5 text-xs font-medium ${TIER_STYLE[tier] ?? ""}`}
                      title="Search-priority tier"
                    >
                      T{tier}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <Link
                      href={`/businesses/${b.id}`}
                      className="font-medium text-stone-900 hover:underline"
                    >
                      {b.name}
                    </Link>
                    {isChain && (
                      <span
                        className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800"
                        title="National/regional chain (OSM brand)"
                      >
                        chain{b.brand ? `: ${b.brand}` : ""}
                      </span>
                    )}
                    {b.website && (
                      <a
                        href={b.website}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ml-1.5 text-xs text-blue-700 hover:underline"
                        title={b.website}
                        aria-label={`Visit ${b.name} website (opens in a new tab)`}
                      >
                        ↗
                      </a>
                    )}
                  </td>
                  <td className="px-3 py-2 text-stone-600">{b.kind ?? "—"}</td>
                  <td className="px-3 py-2 text-stone-500">{b.town ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {size !== "all" && pageCount > 1 && (
        <nav className="flex flex-wrap items-center justify-center gap-1.5 pt-2">
          {page > 1 ? (
            <a
              href={hrefWith(current, { page: String(page - 1) })}
              className={pill(false)}
              aria-label="Previous page"
            >
              ‹
            </a>
          ) : (
            <span className={`${pill(false)} opacity-40`} aria-hidden="true">
              ‹
            </span>
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
            <a
              href={hrefWith(current, { page: String(page + 1) })}
              className={pill(false)}
              aria-label="Next page"
            >
              ›
            </a>
          ) : (
            <span className={`${pill(false)} opacity-40`} aria-hidden="true">
              ›
            </span>
          )}
        </nav>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm -w @localfinds/web exec -- tsc --noEmit` then `echo "EXIT: $?"`
Expected: exit 0, no errors.

- [ ] **Step 3: Commit** (two separate Bash calls)

```bash
git add apps/web/src/app/businesses/page.tsx
```
```bash
git commit -m "feat(web): rebuild /businesses as a paginated, sortable table

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Add the `/businesses/[id]` detail page

**Files:**
- Create: `apps/web/src/app/businesses/[id]/page.tsx`

- [ ] **Step 1: Create the detail page**

Create `apps/web/src/app/businesses/[id]/page.tsx` with EXACTLY:

```tsx
import { getBusinessById, readAgentNote, readCategoryConfig } from "@localfinds/db";
import Link from "next/link";
import { notFound } from "next/navigation";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

export const dynamic = "force-dynamic";

const STATUS_STYLE: Record<string, string> = {
  active: "bg-green-100 text-green-800",
  closed: "bg-red-100 text-red-800",
  unknown: "bg-stone-200 text-stone-600",
};

const TIER_STYLE: Record<number, string> = {
  1: "bg-emerald-100 text-emerald-800",
  2: "bg-sky-100 text-sky-800",
  3: "bg-stone-100 text-stone-600",
  4: "bg-stone-100 text-stone-400",
};

export default async function BusinessDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: idParam } = await params;
  // Number() (not parseInt) so "1abc" becomes NaN and 404s instead of parsing to 1.
  const id = Number(idParam);
  if (!Number.isInteger(id) || id <= 0) notFound();

  const business = getBusinessById(id);
  if (!business) notFound();

  const cfg = readCategoryConfig();
  const tier = cfg.tierOf(business.kind);
  const isChain = Boolean(business.brand);
  const note = readAgentNote("cartographer", business.notesPath);

  return (
    <div className="flex flex-col gap-4">
      <Link href="/businesses" className="text-xs text-blue-700 hover:underline">
        ← Back to businesses
      </Link>

      <div className="flex flex-col gap-2 rounded-lg border border-stone-200 bg-white p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`rounded px-1.5 py-0.5 text-xs font-medium ${TIER_STYLE[tier] ?? ""}`}
            title="Search-priority tier"
          >
            T{tier}
          </span>
          <h2 className="text-base font-semibold">{business.name}</h2>
          {business.kind && (
            <span className="rounded bg-stone-100 px-1.5 py-0.5 text-xs text-stone-600">
              {business.kind}
            </span>
          )}
          {isChain && (
            <span
              className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800"
              title="National/regional chain (OSM brand)"
            >
              chain{business.brand ? `: ${business.brand}` : ""}
            </span>
          )}
          <span
            className={`rounded px-1.5 py-0.5 text-xs ${STATUS_STYLE[business.status] ?? ""}`}
          >
            {business.status}
          </span>
          {business.town && <span className="text-xs text-stone-500">{business.town}</span>}
        </div>

        {business.address && <div className="text-sm text-stone-600">{business.address}</div>}

        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-stone-500">
          {business.website && (
            <a
              href={business.website}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-700 hover:underline"
            >
              {business.website}
            </a>
          )}
          {business.phone && <span>{business.phone}</span>}
          <a
            href={`https://www.openstreetmap.org/${business.osmId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:underline"
          >
            {business.osmId}
          </a>
        </div>

        {business.tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {business.tags.map((t) => (
              <Link
                key={t}
                href={`/businesses?tag=${encodeURIComponent(t)}`}
                className="rounded bg-stone-100 px-1.5 py-0.5 text-xs text-stone-600 hover:bg-stone-200"
              >
                {t}
              </Link>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-lg border border-stone-200 bg-white p-4">
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-stone-400">
          Cartographer note
        </h3>
        {note ? (
          <div className="prose prose-sm prose-stone max-w-none">
            <Markdown remarkPlugins={[remarkGfm]}>{note}</Markdown>
          </div>
        ) : (
          <p className="text-sm text-stone-500">No note yet.</p>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm -w @localfinds/web exec -- tsc --noEmit` then `echo "EXIT: $?"`
Expected: exit 0, no errors.

- [ ] **Step 3: Commit** (two separate Bash calls; quote the bracketed path so the shell doesn't glob it)

```bash
git add "apps/web/src/app/businesses/[id]/page.tsx"
```
```bash
git commit -m "feat(web): add /businesses/[id] detail page

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification

- [ ] Run the full suite: `npm test` — db, agents, web all green (incl. `business-sort.test.ts` and the new `queries.test.ts` block).
- [ ] Run `npm -w @localfinds/web exec -- tsc --noEmit` — exit 0.

---

## Self-Review notes (author check against the spec)

- **Spec coverage:** Sortable Tier/Name/Kind/Town table → Task 3. Detail page with contact line + tag-chip filtering + note + 404 → Task 4. `sort`/`dir` in the query, default-ranking preserved → Task 2 (uses Task 1's helper). Pure tested ordering helper + parsers → Task 1. `getBusinessById` next to `listBusinessesRanked` (merge-friendly) → Task 2. Header card, pagination, filters kept → Task 3 (verbatim from the current page). Non-goals (no pagination removal, no schema change, no UI editing) respected.
- **Type consistency:** `BusinessSort` (`tier|name|kind|town`), `SortDir` (`asc|desc`), `sortRankedBusinesses`, `parseBusinessSort`, `parseDir` are defined in Task 1, consumed unchanged in Tasks 2–3. `RankedBusinessFilters.sort/dir` (Task 2) match the page's call (Task 3). `getBusinessById(id): Business | undefined` (Task 2) matches the Task 4 call site. The page's `COLUMNS[].key` is typed `BusinessSort`, so headers can only sort real columns.
- **No placeholders:** every code and command step is concrete.
