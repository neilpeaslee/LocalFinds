# Cartographer Business Dedup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse OSM elements that represent the same real business (same name, within ~50m) into one canonical row so they stop appearing as duplicate map pins and double-counted directory entries.

**Architecture:** A pure geo/name-matching module (`business-dedupe.ts`) groups duplicate rows; a DB function (`dedupeBusinesses()`) marks the non-canonical rows with a new `duplicate_of` column pointing at the canonical `osm_id`, merging missing facts up first; `listBusinesses()` hides marked rows by default; the cartographer runs the sweep after every successful run, and a one-time script cleans existing data.

**Tech Stack:** TypeScript, Drizzle ORM + better-sqlite3, Vitest, drizzle-kit (`db:push`), tsx.

---

## Background (read before starting)

The spec is at `docs/superpowers/specs/2026-06-14-cartographer-business-dedup-design.md`.

Key facts about this codebase:
- The `businesses` table (`packages/db/src/schema.ts`) is keyed on `osm_id` (its only unique index). OSM maps one place as multiple elements (node + building way, or two ways), each with a distinct `osm_id`, so they become separate rows. Example: `Dorman's Dairy Dream` is `way/628935345` and `way/628935346` at identical coordinates.
- `db()` (`packages/db/src/client.ts`) returns a Drizzle better-sqlite3 instance. `db().transaction((tx) => {...})` is **synchronous**.
- `packages/db/src/dedupe.ts` already exists and handles *finds URL* dedup. It exports `normalizeTitle(s)` = `s.toLowerCase().replace(/\s+/g, " ").trim()` — reuse it for business-name normalization. Do **not** put business logic in that file; create a new `business-dedupe.ts`.
- Tests (`packages/db/src/*.test.ts`) run under Vitest. `queries.test.ts` points the package at a temp data dir via `LOCALFINDS_DATA_DIR` and runs `npx drizzle-kit push --force` in `beforeAll`, so a new schema column is picked up automatically.
- Run the db test suite from the repo root with `npm test` (alias for `npm -w @localfinds/db run test`).

---

## File Structure

- **Create** `packages/db/src/business-dedupe.ts` — pure functions: `DedupeRow` type, `metersBetween`, `DUP_RADIUS_M`, `groupBusinessDuplicates`, `chooseCanonical`, `mergeFacts`. No DB imports (reuses only `normalizeTitle` from `./dedupe`).
- **Create** `packages/db/src/business-dedupe.test.ts` — unit tests for the pure module.
- **Modify** `packages/db/src/schema.ts` — add `duplicateOf` column to `businesses`.
- **Modify** `packages/db/src/queries.ts` — add `isNull` import; add `includeDuplicates` filter + default `isNull(duplicateOf)` to `listBusinesses`; add `dedupeBusinesses()`.
- **Modify** `packages/db/src/queries.test.ts` — integration test for `dedupeBusinesses()` + filtering.
- **Modify** `packages/db/src/index.ts` — re-export `./business-dedupe`.
- **Modify** `packages/agents/src/run-agent.ts` — call `dedupeBusinesses()` after a successful cartographer run.
- **Create** `scripts/dedupe-businesses.ts` — one-time cleanup runner.

---

## Task 1: Add the `duplicate_of` schema column

**Files:**
- Modify: `packages/db/src/schema.ts` (the `businesses` table, after `lastSeenAt`)

- [ ] **Step 1: Add the column**

In `packages/db/src/schema.ts`, inside `export const businesses = sqliteTable("businesses", {...})`, add the new column immediately after the `lastSeenAt` line and before the closing `}, (t) => [`:

```ts
  // Last run Overpass still returned this osmId — cursor for the "maybe closed" sweep.
  lastSeenAt: text("last_seen_at").notNull(),
  // Non-null = this row is a hidden duplicate of that canonical osm_id, set by
  // the cartographer's post-run dedupe sweep. Null = canonical or unique.
  duplicateOf: text("duplicate_of"),
}, (t) => [
```

- [ ] **Step 2: Push the schema to the live DB**

Run from the repo root:

```bash
npm run db:push
```

Expected: drizzle-kit reports adding the `duplicate_of` column to `businesses`, no errors. (If it prompts, accept the additive change — adding a nullable column is non-destructive.)

- [ ] **Step 3: Verify the column exists**

Run:

```bash
sqlite3 data/localfinds.db ".schema businesses" | grep duplicate_of
```

Expected: a line containing `` `duplicate_of` text ``.

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/schema.ts
git commit -m "feat(db): add businesses.duplicate_of column for dedupe"
```

---

## Task 2: Pure dedupe module

**Files:**
- Create: `packages/db/src/business-dedupe.ts`
- Test: `packages/db/src/business-dedupe.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/db/src/business-dedupe.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  chooseCanonical,
  groupBusinessDuplicates,
  mergeFacts,
  metersBetween,
  type DedupeRow,
} from "./business-dedupe";

let nextId = 1;
function row(over: Partial<DedupeRow> = {}): DedupeRow {
  return {
    id: nextId++,
    osmId: `way/${1000 + nextId}`,
    name: "Test Place",
    kind: null,
    tags: [],
    address: null,
    town: "Rockland",
    lat: 44.1,
    lng: -69.1,
    website: null,
    phone: null,
    brand: null,
    status: "active",
    discoveredAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("metersBetween", () => {
  it("is zero for the same point and ~10m for a small north offset", () => {
    const a = { lat: 44.0942096, lng: -69.1380283 };
    expect(metersBetween(a, a)).toBeCloseTo(0, 5);
    const b = { lat: a.lat + 0.0000898, lng: a.lng }; // ~10m north
    expect(metersBetween(a, b)).toBeGreaterThan(9);
    expect(metersBetween(a, b)).toBeLessThan(11);
  });
});

describe("groupBusinessDuplicates", () => {
  const base = { lat: 44.0942096, lng: -69.1380283 };

  it("groups same-name rows at identical coordinates", () => {
    const groups = groupBusinessDuplicates([
      row({ name: "Dorman's Dairy Dream", lat: base.lat, lng: base.lng }),
      row({ name: "Dorman's Dairy Dream", lat: base.lat, lng: base.lng }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(2);
  });

  it("groups a node/way pair a few meters apart", () => {
    const groups = groupBusinessDuplicates([
      row({ name: "Cafe X", lat: base.lat, lng: base.lng }),
      row({ name: "Cafe X", lat: base.lat + 0.0000898, lng: base.lng }), // ~10m
    ]);
    expect(groups).toHaveLength(1);
  });

  it("ignores case/whitespace differences in the name", () => {
    const groups = groupBusinessDuplicates([
      row({ name: "Dorman's  Dairy Dream", lat: base.lat, lng: base.lng }),
      row({ name: "dorman's dairy dream", lat: base.lat, lng: base.lng }),
    ]);
    expect(groups).toHaveLength(1);
  });

  it("does NOT group same-name rows more than 50m apart", () => {
    const groups = groupBusinessDuplicates([
      row({ name: "Cafe Y", lat: base.lat, lng: base.lng }),
      row({ name: "Cafe Y", lat: base.lat + 0.001797, lng: base.lng }), // ~200m
    ]);
    expect(groups).toHaveLength(0);
  });

  it("does NOT group different names at the same point", () => {
    const groups = groupBusinessDuplicates([
      row({ name: "Alpha", lat: base.lat, lng: base.lng }),
      row({ name: "Beta", lat: base.lat, lng: base.lng }),
    ]);
    expect(groups).toHaveLength(0);
  });

  it("clusters transitively (A~B, B~C within 50m, A-C beyond)", () => {
    const groups = groupBusinessDuplicates([
      row({ name: "Chain", lat: base.lat, lng: base.lng }),
      row({ name: "Chain", lat: base.lat + 0.0003592, lng: base.lng }), // ~40m from #1
      row({ name: "Chain", lat: base.lat + 0.0007184, lng: base.lng }), // ~40m from #2, ~80m from #1
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(3);
  });

  it("excludes rows without coordinates", () => {
    const groups = groupBusinessDuplicates([
      row({ name: "NoGeo", lat: null, lng: null }),
      row({ name: "NoGeo", lat: null, lng: null }),
    ]);
    expect(groups).toHaveLength(0);
  });
});

describe("chooseCanonical", () => {
  it("prefers an active row over a richer closed row", () => {
    const closedRich = row({
      status: "closed",
      website: "http://x.com",
      phone: "1",
      address: "a",
    });
    const activeSparse = row({ status: "active" });
    expect(chooseCanonical([closedRich, activeSparse]).id).toBe(activeSparse.id);
  });

  it("among same status, prefers the richest", () => {
    const sparse = row({});
    const rich = row({ website: "http://x.com" });
    expect(chooseCanonical([sparse, rich]).id).toBe(rich.id);
  });

  it("breaks ties by oldest discoveredAt then lowest id", () => {
    const older = row({ discoveredAt: "2026-01-01T00:00:00.000Z" });
    const newer = row({ discoveredAt: "2026-02-01T00:00:00.000Z" });
    expect(chooseCanonical([newer, older]).id).toBe(older.id);
  });
});

describe("mergeFacts", () => {
  it("fills only the canonical's missing fields, never overwriting", () => {
    const canonical = row({ website: "http://canonical.com", phone: null, tags: [] });
    const other = row({
      website: "http://other.com",
      phone: "207-555-0000",
      tags: ["cafe"],
    });
    const fill = mergeFacts(canonical, [other]);
    expect(fill.website).toBeUndefined(); // canonical already had one
    expect(fill.phone).toBe("207-555-0000");
    expect(fill.tags).toEqual(["cafe"]);
  });

  it("returns an empty object when the canonical needs nothing", () => {
    const canonical = row({
      website: "http://x.com",
      phone: "1",
      address: "a",
      kind: "amenity=cafe",
      brand: "b",
      town: "Rockland",
      tags: ["t"],
    });
    expect(mergeFacts(canonical, [row({ website: "http://y.com" })])).toEqual({});
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
npm -w @localfinds/db test -- business-dedupe
```

Expected: FAIL — Vitest cannot resolve `./business-dedupe` (module does not exist yet).

- [ ] **Step 3: Write the implementation**

Create `packages/db/src/business-dedupe.ts`:

```ts
import { normalizeTitle } from "./dedupe";

// Two OSM elements within this many metres, sharing a normalized name, are
// treated as the same real business. Tunable; 50m catches node-vs-way centroid
// offsets without merging genuinely distinct same-named neighbours.
export const DUP_RADIUS_M = 50;

// The fields the sweep reads. `Business` (from schema) is structurally
// assignable to this, so DB rows pass straight in without conversion.
export interface DedupeRow {
  id: number;
  osmId: string;
  name: string;
  kind: string | null;
  tags: string[];
  address: string | null;
  town: string | null;
  lat: number | null;
  lng: number | null;
  website: string | null;
  phone: string | null;
  brand: string | null;
  status: "active" | "closed" | "unknown";
  discoveredAt: string;
}

const EARTH_R = 6_371_000; // metres

export function metersBetween(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(h));
}

// More non-null facts = a better canonical candidate.
function richness(r: DedupeRow): number {
  let n = 0;
  if (r.website) n++;
  if (r.phone) n++;
  if (r.address) n++;
  if (r.kind) n++;
  if (r.brand) n++;
  if (r.tags.length > 0) n++;
  return n;
}

const STATUS_RANK: Record<DedupeRow["status"], number> = {
  active: 0,
  unknown: 1,
  closed: 2,
};

// Cluster rows that share a normalized name and fall within DUP_RADIUS_M of one
// another (transitive: A~B and B~C groups all three). Rows without coordinates
// are never grouped. Returns only clusters of 2+.
export function groupBusinessDuplicates(rows: DedupeRow[]): DedupeRow[][] {
  const byName = new Map<string, DedupeRow[]>();
  for (const r of rows) {
    if (r.lat == null || r.lng == null) continue;
    const key = normalizeTitle(r.name);
    const bucket = byName.get(key);
    if (bucket) bucket.push(r);
    else byName.set(key, [r]);
  }

  const groups: DedupeRow[][] = [];
  for (const bucket of byName.values()) {
    if (bucket.length < 2) continue;

    // Union-find over the bucket, joining any pair within the radius.
    const parent = bucket.map((_, i) => i);
    const find = (i: number): number =>
      parent[i] === i ? i : (parent[i] = find(parent[i]));
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const d = metersBetween(
          { lat: bucket[i].lat as number, lng: bucket[i].lng as number },
          { lat: bucket[j].lat as number, lng: bucket[j].lng as number },
        );
        if (d <= DUP_RADIUS_M) parent[find(i)] = find(j);
      }
    }

    const clusters = new Map<number, DedupeRow[]>();
    bucket.forEach((r, i) => {
      const root = find(i);
      const cluster = clusters.get(root);
      if (cluster) cluster.push(r);
      else clusters.set(root, [r]);
    });
    for (const cluster of clusters.values()) {
      if (cluster.length >= 2) groups.push(cluster);
    }
  }
  return groups;
}

// The survivor of a duplicate group: active first (the live record should
// represent the place), then richest, then oldest, then lowest id.
export function chooseCanonical(group: DedupeRow[]): DedupeRow {
  return [...group].sort(
    (a, b) =>
      STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
      richness(b) - richness(a) ||
      a.discoveredAt.localeCompare(b.discoveredAt) ||
      a.id - b.id,
  )[0];
}

const MERGE_FIELDS = [
  "website",
  "phone",
  "address",
  "kind",
  "brand",
  "town",
] as const;

// Fill the canonical's empty fields from the other group members (richest
// first). Never overwrites an existing canonical value; tags are filled, not
// unioned. Returns only the fields that should be updated.
export function mergeFacts(
  canonical: DedupeRow,
  others: DedupeRow[],
): Partial<DedupeRow> {
  const ranked = [...others].sort(
    (a, b) =>
      richness(b) - richness(a) ||
      a.discoveredAt.localeCompare(b.discoveredAt) ||
      a.id - b.id,
  );
  const out: Record<string, unknown> = {};
  for (const field of MERGE_FIELDS) {
    if (canonical[field]) continue;
    const donor = ranked.find((r) => r[field]);
    if (donor) out[field] = donor[field];
  }
  if (canonical.tags.length === 0) {
    const donor = ranked.find((r) => r.tags.length > 0);
    if (donor) out.tags = donor.tags;
  }
  return out as Partial<DedupeRow>;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
npm -w @localfinds/db test -- business-dedupe
```

Expected: PASS — all `business-dedupe` tests green.

- [ ] **Step 5: Re-export from the package index**

In `packages/db/src/index.ts`, add a line alongside the existing exports (keep alphabetical-ish order, next to `./dedupe`):

```ts
export * from "./business-dedupe";
```

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/business-dedupe.ts packages/db/src/business-dedupe.test.ts packages/db/src/index.ts
git commit -m "feat(db): pure business dedupe module (name + 50m matching)"
```

---

## Task 3: `dedupeBusinesses()` DB function + hide duplicates in `listBusinesses`

**Files:**
- Modify: `packages/db/src/queries.ts` (imports line 1; `BusinessFilters` + `listBusinesses` ~line 362-389; add `dedupeBusinesses` after `listBusinesses`)
- Test: `packages/db/src/queries.test.ts` (append a describe block)

- [ ] **Step 1: Write the failing integration test**

Append to `packages/db/src/queries.test.ts`:

```ts
describe("dedupeBusinesses", () => {
  it("collapses same-name same-coord OSM elements into one canonical row", () => {
    const a = q.upsertBusiness({
      osmId: "way/900001",
      name: "Dedup Test Cafe",
      lat: 44.2,
      lng: -69.2,
      website: "https://dedup-a.example.com",
      addedBy: "test",
    });
    const b = q.upsertBusiness({
      osmId: "way/900002",
      name: "Dedup Test Cafe",
      lat: 44.2,
      lng: -69.2,
      phone: "207-555-0101",
      addedBy: "test",
    });
    expect(a.outcome).toBe("created");
    expect(b.outcome).toBe("created");

    const summary = q.dedupeBusinesses();
    expect(summary.groups).toBeGreaterThanOrEqual(1);

    // Default view hides the duplicate and keeps one canonical row.
    const visible = q.listBusinesses({ q: "Dedup Test Cafe" });
    expect(visible).toHaveLength(1);
    const canonical = visible[0];
    expect(canonical.osmId).toBe("way/900001"); // older row wins the richness tie
    expect(canonical.website).toBe("https://dedup-a.example.com");
    expect(canonical.phone).toBe("207-555-0101"); // merged up from the duplicate

    // includeDuplicates shows both; the loser points at the canonical osm_id.
    const all = q.listBusinesses({
      q: "Dedup Test Cafe",
      includeDuplicates: true,
    });
    expect(all).toHaveLength(2);
    const dup = all.find((r) => r.osmId === "way/900002");
    expect(dup?.duplicateOf).toBe("way/900001");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
npm -w @localfinds/db test -- queries
```

Expected: FAIL — `q.dedupeBusinesses is not a function` (and `includeDuplicates` has no effect yet).

- [ ] **Step 3: Add the `isNull` import**

In `packages/db/src/queries.ts`, line 1, add `isNull` to the drizzle-orm import (alphabetical):

```ts
import { and, desc, eq, gte, inArray, isNull, ne, sql } from "drizzle-orm";
```

- [ ] **Step 4: Import the pure dedupe helpers**

In `packages/db/src/queries.ts`, next to the existing `import { findKey } from "./dedupe";`, add:

```ts
import {
  chooseCanonical,
  groupBusinessDuplicates,
  mergeFacts,
} from "./business-dedupe";
```

- [ ] **Step 5: Add `includeDuplicates` to the filter + default exclusion**

In `packages/db/src/queries.ts`, change the `BusinessFilters` interface to add the new field:

```ts
export interface BusinessFilters {
  town?: string;
  tag?: string;
  status?: "active" | "closed" | "unknown";
  q?: string;
  limit?: number;
  /** Include rows marked as duplicates of another business. Default false. */
  includeDuplicates?: boolean;
}
```

Then, in `listBusinesses`, add the default exclusion as the first condition (right after `const conditions = [];`):

```ts
export function listBusinesses(filters: BusinessFilters = {}) {
  const conditions = [];
  if (!filters.includeDuplicates) conditions.push(isNull(businesses.duplicateOf));
  if (filters.town) conditions.push(eq(businesses.town, filters.town));
  // ...rest unchanged...
```

- [ ] **Step 6: Add the `dedupeBusinesses` function**

In `packages/db/src/queries.ts`, immediately after the `listBusinesses` function (before `interface RankedBusiness`), add:

```ts
// Collapse OSM elements that describe the same real business (same normalized
// name, within ~50m) into one canonical row. Reads only unmarked rows, so it is
// idempotent; merges the duplicates' missing facts onto the canonical, then
// points each loser's duplicate_of at the canonical osm_id. Run after a
// cartographer scan and as a one-time cleanup.
export function dedupeBusinesses(): { groups: number; marked: number } {
  const rows = db()
    .select()
    .from(businesses)
    .where(isNull(businesses.duplicateOf))
    .all();

  const groups = groupBusinessDuplicates(rows);
  let marked = 0;

  db().transaction((tx) => {
    for (const group of groups) {
      const canonical = chooseCanonical(group);
      const others = group.filter((r) => r.id !== canonical.id);

      const fill = mergeFacts(canonical, others);
      if (Object.keys(fill).length > 0) {
        tx.update(businesses).set(fill).where(eq(businesses.id, canonical.id)).run();
      }

      for (const dup of others) {
        tx.update(businesses)
          .set({ duplicateOf: canonical.osmId })
          .where(eq(businesses.id, dup.id))
          .run();
        marked++;
      }
    }
  });

  return { groups: groups.length, marked };
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run:

```bash
npm -w @localfinds/db test -- queries
```

Expected: PASS — the `dedupeBusinesses` describe block is green and existing `queries` tests still pass.

- [ ] **Step 8: Run the full db suite to confirm nothing regressed**

Run:

```bash
npm test
```

Expected: PASS — all db package tests green (existing business rows have `duplicate_of = null`, so the new default filter changes no existing behaviour).

- [ ] **Step 9: Commit**

```bash
git add packages/db/src/queries.ts packages/db/src/queries.test.ts
git commit -m "feat(db): dedupeBusinesses() sweep + hide duplicates from listBusinesses"
```

---

## Task 4: Run the sweep after each cartographer run

**Files:**
- Modify: `packages/agents/src/run-agent.ts` (import block lines 2-11; success path ~line 186)

- [ ] **Step 1: Import `dedupeBusinesses`**

In `packages/agents/src/run-agent.ts`, add `dedupeBusinesses` to the existing `@localfinds/db` import block (keep alphabetical):

```ts
import {
  agentWorkspaceDir,
  dedupeBusinesses,
  finishRun,
  formatCategoryPriorities,
  openRunLog,
  projectMessage,
  readCategoryConfig,
  readRegionConfig,
  startRun,
} from "@localfinds/db";
```

- [ ] **Step 2: Call the sweep on successful cartographer completion**

In `packages/agents/src/run-agent.ts`, in the `try` block, immediately after the success-path `finishRun(runId, {...});` call (the one around line 176-186, ending with `});`) and before the closing `}` of the `try`, add:

```ts
    // Deterministic post-run housekeeping: collapse OSM duplicate elements the
    // scan may have introduced. Cartographer-only; never LLM-triggered. A
    // failure here must not fail an otherwise-successful run.
    if (status === "success" && def.name === "cartographer") {
      try {
        const summary = dedupeBusinesses();
        console.log(
          `[${def.name}] dedupe: marked ${summary.marked} duplicate(s) across ${summary.groups} group(s)`,
        );
      } catch (err) {
        console.error(`[${def.name}] dedupe sweep failed:`, err);
      }
    }
```

- [ ] **Step 3: Typecheck the agents package**

Run from the repo root:

```bash
npx tsc --noEmit -p packages/agents/tsconfig.json
```

Expected: exit 0, no type errors. (If `packages/agents` has no `tsconfig.json`, run `cd packages/agents && npx tsc --noEmit` instead.)

- [ ] **Step 4: Commit**

```bash
git add packages/agents/src/run-agent.ts
git commit -m "feat(agents): run business dedupe after each cartographer run"
```

---

## Task 5: One-time cleanup of existing data

**Files:**
- Create: `scripts/dedupe-businesses.ts`

- [ ] **Step 1: Write the cleanup script**

Create `scripts/dedupe-businesses.ts`:

```ts
// One-time (and re-runnable) cleanup: collapse duplicate OSM elements already
// in the directory. Resolves the same data dir as the app/agents via @localfinds/db.
// Run from the repo root: npx tsx scripts/dedupe-businesses.ts
import { dedupeBusinesses } from "@localfinds/db";

const summary = dedupeBusinesses();
console.log(
  `Deduped businesses: marked ${summary.marked} duplicate(s) across ${summary.groups} group(s).`,
);
```

- [ ] **Step 2: Run it against the live DB**

Run from the repo root:

```bash
npx tsx scripts/dedupe-businesses.ts
```

Expected: prints e.g. `Deduped businesses: marked 1 duplicate(s) across 1 group(s).` (at least the Dorman pair).

- [ ] **Step 3: Verify Dorman collapsed and the count dropped**

Run:

```bash
sqlite3 -header -column data/localfinds.db "SELECT osm_id, duplicate_of FROM businesses WHERE name LIKE '%Dorman%';"
sqlite3 data/localfinds.db "SELECT COUNT(*) AS visible FROM businesses WHERE duplicate_of IS NULL;"
```

Expected: exactly one Dorman row has `duplicate_of` = NULL (canonical) and the other has it set to the canonical's `osm_id`; `visible` is 366 (down from 367).

- [ ] **Step 4: Commit**

```bash
git add scripts/dedupe-businesses.ts
git commit -m "chore: one-time business dedupe cleanup script"
```

---

## Final verification (after all tasks)

- [ ] **Run the full db test suite:** `npm test` → all green.
- [ ] **Visual check:** `npm run dev`, open the dashboard, confirm the Dorman pin is no longer doubled and "businesses catalogued" reads 366. (No React duplicate-key error in the console — that was fixed separately in commit `04bbb7d`.)
- [ ] **Idempotency:** re-run `npx tsx scripts/dedupe-businesses.ts` → expect `marked 0 duplicate(s) across 0 group(s)` (already-marked rows are skipped).
