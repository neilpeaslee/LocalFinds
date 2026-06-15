# Sources Page Table Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `/sources` accordion list with a searchable, filterable, sortable table plus a summary header, and move each source's markdown note to a `/sources/[id]` detail page.

**Architecture:** All server components rendered with `force-dynamic`, exactly as today. Filter/sort/summary state lives entirely in the URL query string (no client JS). Filtering, sorting, and summarizing happen in a unit-tested pure helper module over the full source list (14 rows today; no pagination). Two thin additive db queries back the new detail page. `listSources()` is left untouched — the agents MCP tool depends on it.

**Tech Stack:** Next.js (App Router, React Server Components), Drizzle ORM over SQLite, Tailwind CSS, Vitest, `react-markdown` + `remark-gfm`.

**Spec:** `docs/superpowers/specs/2026-06-15-sources-page-table-redesign-design.md`

---

## File Structure

| File | Responsibility |
|------|----------------|
| `packages/db/src/queries.ts` | Add `getSourceById(id)` and `listFindsBySource(sourceId, limit)` (additive) |
| `packages/db/src/queries.test.ts` | Tests for the two new queries |
| `apps/web/src/lib/sources.ts` | Pure helpers: `summarizeSources`, `filterSources`, `sortSources`, query-param parsers |
| `apps/web/src/lib/sources.test.ts` | Unit tests for the helpers |
| `apps/web/src/app/sources/page.tsx` | Rewrite: summary/search/filter header card + sortable table |
| `apps/web/src/app/sources/[id]/page.tsx` | New: source detail page (metadata + note + recent finds) |

Conventions to follow (already in the repo):
- Web unit tests: `import { describe, expect, it } from "vitest"` (see `apps/web/src/lib/pagination.test.ts`).
- Page filter UI mirrors `apps/web/src/app/businesses/page.tsx` (`first()`, `hrefWith()`, `pill()` helpers; GET form with hidden inputs for non-`q` state).
- Status badge palette is shared verbatim with the current sources/businesses pages.

---

## Task 1: Add `getSourceById` and `listFindsBySource` db queries

**Files:**
- Modify: `packages/db/src/queries.ts` (add two functions after `listSources`, ~line 259)
- Test: `packages/db/src/queries.test.ts` (append a new `describe` block)

- [ ] **Step 1: Write the failing tests**

Append to `packages/db/src/queries.test.ts` (the file already sets up a throwaway db in `beforeAll` and exposes the module as `q`; it also defines `const sleep = (ms) => new Promise(...)`):

```ts
describe("getSourceById / listFindsBySource", () => {
  it("returns a source by id, or undefined for an unknown id", () => {
    const { id } = q.upsertSource({
      url: "https://t1-library.example.org",
      name: "T1 Library",
      addedBy: "test",
    });
    const found = q.getSourceById(id);
    expect(found?.id).toBe(id);
    expect(found?.name).toBe("T1 Library");
    expect(q.getSourceById(999_999)).toBeUndefined();
  });

  it("lists a source's finds newest-first, capped by limit", async () => {
    const url = "https://t1-news.example.org";
    q.upsertSource({ url, name: "T1 News", addedBy: "test" });

    const older = q.insertFind({ title: "T1 older", url: `${url}/a`, agent: "test", sourceUrl: url });
    await sleep(5);
    const newer = q.insertFind({ title: "T1 newer", url: `${url}/b`, agent: "test", sourceUrl: url });

    const sourceId = q.getSourceById(
      // resolve the id we just created/updated
      q.listSources().find((s) => s.url === url)!.id,
    )!.id;

    const finds = q.listFindsBySource(sourceId);
    expect(finds.map((f) => f.id)).toEqual([newer.id, older.id]);

    const capped = q.listFindsBySource(sourceId, 1);
    expect(capped.map((f) => f.id)).toEqual([newer.id]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm -w @localfinds/db run test -- queries.test.ts`
Expected: FAIL — `q.getSourceById is not a function` / `q.listFindsBySource is not a function`.

- [ ] **Step 3: Implement the two queries**

In `packages/db/src/queries.ts`, immediately after the `listSources` function (around line 259), add:

```ts
export function getSourceById(id: number): Source | undefined {
  return db().select().from(sources).where(eq(sources.id, id)).get();
}

export function listFindsBySource(sourceId: number, limit = 10): Find[] {
  return db()
    .select()
    .from(finds)
    .where(eq(finds.sourceId, sourceId))
    .orderBy(desc(finds.discoveredAt))
    .limit(limit)
    .all();
}
```

Then ensure the `Source` and `Find` types are imported. The existing schema import block (lines 12-19) imports `Business`, `businesses`, `feedback`, `finds`, `runs`, `sources` — add the two types:

```ts
import {
  type Business,
  type Find,
  type Source,
  businesses,
  feedback,
  finds,
  runs,
  sources,
} from "./schema";
```

(`db`, `eq`, and `desc` are already imported at the top of the file.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm -w @localfinds/db run test -- queries.test.ts`
Expected: PASS — the whole `queries.test.ts` suite green, including the new block.

- [ ] **Step 5: Commit** (run as two separate calls)

```bash
git add packages/db/src/queries.ts packages/db/src/queries.test.ts
```
```bash
git commit -m "feat(db): add getSourceById and listFindsBySource queries

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Pure helpers `lib/sources.ts` (summary / filter / sort / parsers)

**Files:**
- Create: `apps/web/src/lib/sources.ts`
- Test: `apps/web/src/lib/sources.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/lib/sources.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Source } from "@localfinds/db";
import {
  filterSources,
  parseDir,
  parseSort,
  parseStatus,
  sortSources,
  summarizeSources,
} from "./sources";

// Minimal Source factory — only the fields the helpers read need to be realistic.
function src(over: Partial<Source>): Source {
  return {
    id: 1,
    url: "https://example.org",
    name: "Example",
    notesPath: null,
    status: "active",
    qualityScore: null,
    findsCount: 0,
    lastFindAt: null,
    lastCheckedAt: null,
    addedBy: "test",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("summarizeSources", () => {
  it("counts totals, statuses, finds, and average quality over ALL sources", () => {
    const s = summarizeSources([
      src({ id: 1, status: "active", findsCount: 3, qualityScore: 8 }),
      src({ id: 2, status: "active", findsCount: 5, qualityScore: 6 }),
      src({ id: 3, status: "paused", findsCount: 0, qualityScore: null }),
    ]);
    expect(s.total).toBe(3);
    expect(s.byStatus).toEqual({ active: 2, paused: 1, dead: 0 });
    expect(s.totalFinds).toBe(8);
    expect(s.avgQuality).toBe(7); // (8 + 6) / 2, nulls excluded from the mean
  });

  it("reports null average when no source has a quality score", () => {
    expect(summarizeSources([src({ qualityScore: null })]).avgQuality).toBeNull();
  });
});

describe("filterSources", () => {
  const sources = [
    src({ id: 1, name: "Town Library", url: "https://lib.example.org", status: "active" }),
    src({ id: 2, name: "Rec Dept", url: "https://rec.example.org", status: "paused" }),
  ];

  it("matches q case-insensitively against name and url", () => {
    expect(filterSources(sources, { q: "library" }).map((s) => s.id)).toEqual([1]);
    expect(filterSources(sources, { q: "REC.EXAMPLE" }).map((s) => s.id)).toEqual([2]);
  });

  it("filters by exact status and combines with q", () => {
    expect(filterSources(sources, { status: "paused" }).map((s) => s.id)).toEqual([2]);
    expect(filterSources(sources, { q: "example", status: "active" }).map((s) => s.id)).toEqual([1]);
  });

  it("returns all sources for an empty query", () => {
    expect(filterSources(sources, {}).length).toBe(2);
  });
});

describe("sortSources", () => {
  const sources = [
    src({ id: 1, name: "Beta", findsCount: 5, qualityScore: 7, lastCheckedAt: "2026-06-10" }),
    src({ id: 2, name: "alpha", findsCount: 2, qualityScore: 9, lastCheckedAt: "2026-06-15" }),
    src({ id: 3, name: "Gamma", findsCount: 9, qualityScore: null, lastCheckedAt: null }),
  ];

  it("sorts by name ascending, case-insensitively", () => {
    expect(sortSources(sources, "name", "asc").map((s) => s.id)).toEqual([2, 1, 3]);
  });

  it("sorts numeric and date columns descending", () => {
    expect(sortSources(sources, "finds", "desc").map((s) => s.id)).toEqual([3, 1, 2]);
    expect(sortSources(sources, "checked", "desc").map((s) => s.id)).toEqual([2, 1, 3]);
  });

  it("puts null sort values last regardless of direction", () => {
    expect(sortSources(sources, "quality", "asc").map((s) => s.id)).toEqual([1, 2, 3]);
    expect(sortSources(sources, "quality", "desc").map((s) => s.id)).toEqual([2, 1, 3]);
  });

  it("does not mutate the input array", () => {
    const input = [...sources];
    sortSources(input, "finds", "asc");
    expect(input.map((s) => s.id)).toEqual([1, 2, 3]);
  });
});

describe("query-param parsers", () => {
  it("parseSort falls back to name for unknown keys", () => {
    expect(parseSort("finds")).toBe("finds");
    expect(parseSort("bogus")).toBe("name");
    expect(parseSort(undefined)).toBe("name");
  });

  it("parseDir defaults to asc", () => {
    expect(parseDir("desc")).toBe("desc");
    expect(parseDir("asc")).toBe("asc");
    expect(parseDir(undefined)).toBe("asc");
  });

  it("parseStatus only accepts known statuses", () => {
    expect(parseStatus("paused")).toBe("paused");
    expect(parseStatus("bogus")).toBeUndefined();
    expect(parseStatus(undefined)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm -w @localfinds/web run test -- src/lib/sources.test.ts`
Expected: FAIL — cannot resolve `./sources` (module does not exist yet).

- [ ] **Step 3: Implement the helpers**

Create `apps/web/src/lib/sources.ts`:

```ts
// View-side helpers for the /sources table. The summary is computed over the
// full source list (not the filtered set) so the header reads as a stable
// dashboard line; filtering and sorting are pure and unit-tested.
import type { Source } from "@localfinds/db";

export type SourceStatus = "active" | "paused" | "dead";
export const SOURCE_STATUSES: SourceStatus[] = ["active", "paused", "dead"];

export type SourceSort = "name" | "finds" | "quality" | "checked";
export type SortDir = "asc" | "desc";

export interface SourceSummary {
  total: number;
  byStatus: Record<SourceStatus, number>;
  totalFinds: number;
  avgQuality: number | null; // null when no source carries a quality score
}

export function summarizeSources(sources: Source[]): SourceSummary {
  const byStatus: Record<SourceStatus, number> = { active: 0, paused: 0, dead: 0 };
  let totalFinds = 0;
  let qualitySum = 0;
  let qualityCount = 0;
  for (const s of sources) {
    byStatus[s.status] += 1;
    totalFinds += s.findsCount;
    if (s.qualityScore != null) {
      qualitySum += s.qualityScore;
      qualityCount += 1;
    }
  }
  return {
    total: sources.length,
    byStatus,
    totalFinds,
    avgQuality: qualityCount > 0 ? qualitySum / qualityCount : null,
  };
}

export function filterSources(
  sources: Source[],
  opts: { q?: string; status?: SourceStatus },
): Source[] {
  const q = opts.q?.trim().toLowerCase();
  return sources.filter((s) => {
    if (opts.status && s.status !== opts.status) return false;
    if (q) {
      const hay = `${s.name ?? ""} ${s.url}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

// Stable sort by the chosen key/direction; returns a new array. Null sort
// values (missing quality or lastCheckedAt) always sort last, in both
// directions. The name key never produces null (falls back to the url).
export function sortSources(
  sources: Source[],
  sort: SourceSort,
  dir: SortDir,
): Source[] {
  const factor = dir === "asc" ? 1 : -1;
  const valueOf = (s: Source): string | number | null => {
    switch (sort) {
      case "name":
        return (s.name ?? s.url).toLowerCase();
      case "finds":
        return s.findsCount;
      case "quality":
        return s.qualityScore;
      case "checked":
        return s.lastCheckedAt;
    }
  };
  return [...sources].sort((a, b) => {
    const av = valueOf(a);
    const bv = valueOf(b);
    if (av == null && bv == null) return 0;
    if (av == null) return 1; // nulls last
    if (bv == null) return -1;
    if (av < bv) return -1 * factor;
    if (av > bv) return 1 * factor;
    return 0;
  });
}

export function parseSort(raw: string | undefined): SourceSort {
  return raw === "finds" || raw === "quality" || raw === "checked" ? raw : "name";
}

export function parseDir(raw: string | undefined): SortDir {
  return raw === "desc" ? "desc" : "asc";
}

export function parseStatus(raw: string | undefined): SourceStatus | undefined {
  return raw === "active" || raw === "paused" || raw === "dead" ? raw : undefined;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm -w @localfinds/web run test -- src/lib/sources.test.ts`
Expected: PASS — all describe blocks green.

- [ ] **Step 5: Commit** (run as two separate calls)

```bash
git add apps/web/src/lib/sources.ts apps/web/src/lib/sources.test.ts
```
```bash
git commit -m "feat(web): add pure summary/filter/sort helpers for /sources

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Rewrite the `/sources` page (header card + sortable table)

**Files:**
- Modify: `apps/web/src/app/sources/page.tsx` (full rewrite)

This is a server component (no unit test, matching the repo — no page has one). Verification is a typecheck plus a manual load.

- [ ] **Step 1: Replace the page with the table implementation**

Overwrite `apps/web/src/app/sources/page.tsx` with:

```tsx
import { listSources } from "@localfinds/db";
import Link from "next/link";
import {
  type SortDir,
  type SourceSort,
  SOURCE_STATUSES,
  filterSources,
  parseDir,
  parseSort,
  parseStatus,
  sortSources,
  summarizeSources,
} from "@/lib/sources";

export const dynamic = "force-dynamic";

const STATUS_STYLE: Record<string, string> = {
  active: "bg-green-100 text-green-800",
  paused: "bg-stone-200 text-stone-600",
  dead: "bg-red-100 text-red-800",
};

// Column order matches the spec: Name · Status · Finds · Quality · Last checked.
// Status is intentionally not sortable (use the filter pills instead).
const COLUMNS: {
  key: SourceSort | "status";
  label: string;
  sortable: boolean;
  align: string;
}[] = [
  { key: "name", label: "Name", sortable: true, align: "text-left" },
  { key: "status", label: "Status", sortable: false, align: "text-left" },
  { key: "finds", label: "Finds", sortable: true, align: "text-right" },
  { key: "quality", label: "Quality", sortable: true, align: "text-right" },
  { key: "checked", label: "Last checked", sortable: true, align: "text-right" },
];

type Query = { q?: string; status?: string; sort?: string; dir?: string };

// Next.js delivers string[] for a repeated query key; take the first.
function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function hrefWith(current: Query, patch: Query): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...current, ...patch })) {
    if (v) params.set(k, v);
  }
  const qs = params.toString();
  return qs ? `/sources?${qs}` : "/sources";
}

function pill(active: boolean): string {
  return `rounded px-2 py-0.5 text-xs ${
    active ? "bg-stone-800 text-white" : "bg-stone-100 text-stone-600 hover:bg-stone-200"
  }`;
}

function shortDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString() : "—";
}

export default async function SourcesPage({
  searchParams,
}: {
  searchParams: Promise<Query & Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const q = first(params.q)?.trim() || undefined;
  const status = parseStatus(first(params.status));
  const sort = parseSort(first(params.sort));
  const dir = parseDir(first(params.dir));

  const all = listSources();

  if (all.length === 0) {
    return (
      <p className="py-12 text-center text-sm text-stone-500">
        No sources registered yet. The source-keeper agent populates this on
        its first run (seed it via data/config/region.md).
      </p>
    );
  }

  const summary = summarizeSources(all);
  const rows = sortSources(filterSources(all, { q, status }), sort, dir);

  // `sort`/`dir` ride along on filter links; their defaults (name/asc) stay
  // implicit to keep URLs clean.
  const current: Query = {
    q,
    status,
    sort: sort === "name" ? undefined : sort,
    dir: dir === "asc" ? undefined : dir,
  };
  const hasFilters = Boolean(q || status);

  const summaryParts = [
    `${summary.total} ${summary.total === 1 ? "source" : "sources"}`,
    ...SOURCE_STATUSES.filter((s) => summary.byStatus[s] > 0).map(
      (s) => `${summary.byStatus[s]} ${s}`,
    ),
    `${summary.totalFinds} ${summary.totalFinds === 1 ? "find" : "finds"}`,
  ];
  if (summary.avgQuality != null) {
    summaryParts.push(`avg quality ${summary.avgQuality.toFixed(1)}`);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 rounded-lg border border-stone-200 bg-white p-3">
        <p className="text-xs text-stone-500">{summaryParts.join(" · ")}</p>

        <form action="/sources" className="flex gap-2">
          {status && <input type="hidden" name="status" value={status} />}
          {current.sort && <input type="hidden" name="sort" value={current.sort} />}
          {current.dir && <input type="hidden" name="dir" value={current.dir} />}
          <input
            type="search"
            name="q"
            defaultValue={q ?? ""}
            placeholder="Search by name or URL…"
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
          {SOURCE_STATUSES.map((s) => (
            <a key={s} href={hrefWith(current, { status: s })} className={pill(status === s)}>
              {s}
            </a>
          ))}
        </div>
      </div>

      <p className="text-xs text-stone-500">
        {hasFilters
          ? `${rows.length} of ${all.length} matching filters`
          : `${all.length} ${all.length === 1 ? "source" : "sources"}`}
      </p>

      {rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-stone-500">
          No sources match these filters.
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-stone-200 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-stone-200 text-xs text-stone-500">
                {COLUMNS.map((col) => {
                  if (!col.sortable) {
                    return (
                      <th key={col.key} className={`px-3 py-2 font-medium ${col.align}`}>
                        {col.label}
                      </th>
                    );
                  }
                  const sortKey = col.key as SourceSort;
                  const isActive = sort === sortKey;
                  const nextDir: SortDir = isActive && dir === "asc" ? "desc" : "asc";
                  return (
                    <th key={col.key} className={`px-3 py-2 font-medium ${col.align}`}>
                      <a
                        href={hrefWith(current, { sort: sortKey, dir: nextDir })}
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
              {rows.map((s) => (
                <tr key={s.id} className="border-b border-stone-100 last:border-0">
                  <td className="px-3 py-2">
                    <Link
                      href={`/sources/${s.id}`}
                      className="font-medium text-stone-900 hover:underline"
                    >
                      {s.name ?? new URL(s.url).hostname}
                    </Link>
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ml-1.5 text-xs text-blue-700 hover:underline"
                      title={s.url}
                    >
                      ↗
                    </a>
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`rounded px-1.5 py-0.5 text-xs ${STATUS_STYLE[s.status] ?? ""}`}
                    >
                      {s.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{s.findsCount}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {s.qualityScore != null ? s.qualityScore.toFixed(1) : "—"}
                  </td>
                  <td className="px-3 py-2 text-right text-stone-500">
                    {shortDate(s.lastCheckedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm -w @localfinds/web exec -- tsc --noEmit`
Expected: exit 0, no errors.

- [ ] **Step 3: Manual verification**

Run `npm run dev`, then open `http://localhost:3000/sources` and confirm:
- Summary line reads e.g. `14 sources · 12 active · 2 paused · 19 finds · avg quality X.X`.
- Typing in the search box and pressing Search filters by name/URL; the result line switches to `N of 14 matching filters`.
- Each status pill filters; `all` clears it; the active pill is highlighted.
- Clicking the Name / Finds / Quality / Last checked headers sorts and shows a ▲/▼; clicking again reverses it; search + status survive the sort.
- A source name links to its detail page; the `↗` opens the real site in a new tab.

- [ ] **Step 4: Commit** (run as two separate calls)

```bash
git add apps/web/src/app/sources/page.tsx
```
```bash
git commit -m "feat(web): rebuild /sources as a searchable, sortable table

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Add the `/sources/[id]` detail page

**Files:**
- Create: `apps/web/src/app/sources/[id]/page.tsx`

- [ ] **Step 1: Create the detail page**

Create `apps/web/src/app/sources/[id]/page.tsx`:

```tsx
import { getSourceById, listFindsBySource, readAgentNote } from "@localfinds/db";
import Link from "next/link";
import { notFound } from "next/navigation";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

export const dynamic = "force-dynamic";

const STATUS_STYLE: Record<string, string> = {
  active: "bg-green-100 text-green-800",
  paused: "bg-stone-200 text-stone-600",
  dead: "bg-red-100 text-red-800",
};

const FIND_STATUS_STYLE: Record<string, string> = {
  new: "bg-blue-100 text-blue-800",
  shown: "bg-stone-100 text-stone-600",
  hidden: "bg-stone-200 text-stone-500",
  starred: "bg-amber-100 text-amber-800",
};

function shortDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString() : "—";
}

export default async function SourceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: idParam } = await params;
  const id = Number.parseInt(idParam, 10);
  if (!Number.isInteger(id) || id <= 0) notFound();

  const source = getSourceById(id);
  if (!source) notFound();

  const note = readAgentNote("source-keeper", source.notesPath);
  const finds = listFindsBySource(source.id, 10);

  const meta = [
    source.qualityScore != null ? `quality ${source.qualityScore.toFixed(1)}` : null,
    `${source.findsCount} ${source.findsCount === 1 ? "find" : "finds"}`,
    source.lastCheckedAt ? `checked ${shortDate(source.lastCheckedAt)}` : null,
    `added by ${source.addedBy}`,
    `created ${shortDate(source.createdAt)}`,
  ].filter(Boolean);

  return (
    <div className="flex flex-col gap-4">
      <Link href="/sources" className="text-xs text-blue-700 hover:underline">
        ← Back to sources
      </Link>

      <div className="flex flex-col gap-2 rounded-lg border border-stone-200 bg-white p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-semibold">
            {source.name ?? new URL(source.url).hostname}
          </h2>
          <a
            href={source.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-blue-700 hover:underline"
          >
            {source.url} ↗
          </a>
          <span
            className={`rounded px-1.5 py-0.5 text-xs ${STATUS_STYLE[source.status] ?? ""}`}
          >
            {source.status}
          </span>
        </div>
        <p className="text-xs text-stone-500">{meta.join(" · ")}</p>
      </div>

      <div className="rounded-lg border border-stone-200 bg-white p-4">
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-stone-400">
          Site note
        </h3>
        {note ? (
          <div className="prose prose-sm prose-stone max-w-none">
            <Markdown remarkPlugins={[remarkGfm]}>{note}</Markdown>
          </div>
        ) : (
          <p className="text-sm text-stone-500">No site note yet.</p>
        )}
      </div>

      {finds.length > 0 && (
        <div className="rounded-lg border border-stone-200 bg-white p-4">
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-stone-400">
            Recent finds from this source
          </h3>
          <ul className="flex flex-col divide-y divide-stone-100">
            {finds.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                {f.url ? (
                  <a
                    href={f.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-stone-900 hover:underline"
                  >
                    {f.title}
                  </a>
                ) : (
                  <span className="font-medium text-stone-900">{f.title}</span>
                )}
                <span
                  className={`rounded px-1.5 py-0.5 text-xs ${FIND_STATUS_STYLE[f.status] ?? ""}`}
                >
                  {f.status}
                </span>
                <span className="ml-auto text-xs text-stone-500">
                  {shortDate(f.discoveredAt)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm -w @localfinds/web exec -- tsc --noEmit`
Expected: exit 0, no errors.

- [ ] **Step 3: Manual verification**

With `npm run dev` running:
- From `/sources`, click a source name → lands on `/sources/<id>`.
- Header shows name + clickable `url ↗`, the status badge, and the metadata line (quality · finds · checked · added by · created), with null segments omitted.
- The site note renders as markdown (or "No site note yet." for a source without one).
- "Recent finds from this source" lists up to 10 finds when the source has any, and is absent when it has none.
- "← Back to sources" returns to the table.
- Visiting `http://localhost:3000/sources/999999` and `http://localhost:3000/sources/abc` both render the Next.js 404.

- [ ] **Step 4: Commit** (run as two separate calls)

```bash
git add apps/web/src/app/sources/[id]/page.tsx
```
```bash
git commit -m "feat(web): add /sources/[id] detail page with note + recent finds

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification

- [ ] Run the full suite: `npm test` — db, agents, and web workspaces all green.
- [ ] Run `npm -w @localfinds/web exec -- tsc --noEmit` once more — exit 0.

---

## Self-Review notes (author check against the spec)

- **Spec coverage:** Header card with summary/search/status filter → Task 3. Table with Name·Status·Finds·Quality·Last-checked + click-to-sort → Task 3. Detail page with note + recent finds + 404 → Task 4. Additive `getSourceById`/`listFindsBySource` → Task 1. Pure tested helpers → Task 2. `listSources()` untouched → confirmed (Task 1 only adds functions). Non-goals (no pagination, no schema change, no UI editing) respected.
- **Type consistency:** `SourceSort` (`name|finds|quality|checked`), `SortDir` (`asc|desc`), `SourceStatus`, and `SOURCE_STATUSES` are defined in Task 2 and consumed unchanged in Task 3. `getSourceById`/`listFindsBySource` signatures in Task 1 match their call sites in Task 4. Status column is non-sortable in both the type (`SourceSort` excludes `status`) and the `COLUMNS` table.
- **No placeholders:** every code and command step is concrete.
