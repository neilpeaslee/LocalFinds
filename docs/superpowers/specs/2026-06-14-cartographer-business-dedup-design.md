# Cartographer business dedup — design

_Date: 2026-06-14_

## Problem

The cartographer mirrors OpenStreetMap into the `businesses` table, keyed on the
OSM stable id (`osm_id`, the table's only unique index). OSM frequently maps one
real-world place as **two distinct elements** — e.g. a point node and a building
way, or two overlapping ways — each with its own `osm_id`. The upsert keys on
`osm_id`, so both become separate rows.

Observed case: `Dorman's Dairy Dream` exists as `way/628935345` (id 322) and
`way/628935346` (id 48), identical name and coordinates
(`44.0942096, -69.1380283`). These render as two overlapping map pins, double the
"businesses catalogued" count, and previously triggered a React duplicate-key
crash on the dashboard (since fixed separately by keying pins on the DB row id).

A prompt instruction to the cartographer agent would be unreliable — these are
structural OSM artifacts an LLM won't consistently notice. The rule must be
**deterministic code**.

## Decisions (locked)

- **Mechanism:** a sweep that marks duplicates with a `duplicate_of` pointer
  (not hard-delete). Churn-free and reversible.
- **Match rule:** same **normalized name** AND coordinates **within ~50m**.
  Catches both identical-coord dupes (Dorman) and node-vs-way pairs whose
  centroids differ by a few meters.
- **`duplicate_of` stores the canonical row's `osm_id`** (stable, human-readable),
  not the autoincrement `id`.
- **Sweep runs automatically** as a deterministic post-run step after every
  successful cartographer run, plus once now to clean existing data.

## Architecture

Five units, each independently understandable and testable:

### 1. Schema — `packages/db/src/schema.ts` (+ `npm run db:push`)

Add one nullable column to the `businesses` table:

```ts
// Non-null = this row is a hidden duplicate of that canonical osm_id.
// Null = canonical or unique. Reversible: clear to un-merge.
duplicateOf: text("duplicate_of"),
```

No new index needed at 367 rows; revisit if the table grows large. Applied with
`npm run db:push` (drizzle-kit), consistent with the project's existing flow.

### 2. Pure dedupe module — `packages/db/src/dedupe.ts` (no DB imports)

Pure functions, unit-tested in isolation:

- `normalizeName(s: string): string` — `trim().toLowerCase()` with internal
  whitespace collapsed to single spaces.
- `metersBetween(a, b): number` — haversine distance between two `{lat, lng}`.
- `groupDuplicates(rows): Row[][]` — cluster rows that share a normalized name
  AND fall within **50m** of each other. Clustering is **transitive**
  (union-find): if A–B and B–C are each within 50m, all three group even if A–C
  exceeds 50m. Rows missing `lat`/`lng` are never grouped (cannot confirm the
  same place). Returns only groups of size ≥ 2.
- `chooseCanonical(group): Row` — prefer an **active** row (`active` > `unknown`
  > `closed`) so the live record represents the place; then the **richest** row,
  scored by count of non-null among `website`, `phone`, `address`, `kind`,
  `brand`, plus non-empty `tags`; tie-break **oldest `discoveredAt`**, then
  lowest `id` (fully deterministic).
- `mergeFacts(canonical, members): Partial<Row>` — for each of `website`,
  `phone`, `address`, `kind`, `brand`, `town` (and `tags` only when the
  canonical's `tags` is empty), if the canonical's value is null/empty, take the
  first non-null value from the other members in richest-first order. **Never
  overwrites** an existing canonical value, and tags are filled-not-unioned.
  Returns only the fields to update.

Constant `DUP_RADIUS_M = 50` lives here, documented as tunable.

### 3. DB function — `packages/db/src/queries.ts`: `dedupeBusinesses()`

```ts
export function dedupeBusinesses(): { groups: number; marked: number }
```

- Reads all rows where `duplicate_of IS NULL`, regardless of status (already-
  marked dups are skipped on re-run, so the sweep is idempotent). Status is
  handled by `chooseCanonical`'s active-first preference, not by filtering — so
  an active+closed pair still collapses instead of both showing as pins.
- Calls `groupDuplicates`, then for each group: `chooseCanonical`, apply
  `mergeFacts` to the canonical, and set `duplicate_of = <canonical osm_id>` on
  every other member.
- All writes in **one transaction**.
- Returns a summary for logging.

### 4. Query filtering — `packages/db/src/queries.ts`: `listBusinesses`

- Add a default condition `isNull(businesses.duplicateOf)` to the base query.
- Add an opt-in `includeDuplicates?: boolean` filter (default false) for
  admin/debugging.

Because `listBusinessesRanked`, the agent's `list_businesses` tool, the
`/businesses` page, the map pins (`page.tsx`), and the "businesses catalogued"
count all flow through `listBusinesses`, duplicates disappear from **every**
surface and the agent never re-handles them. The Dorman count drops 367 → 366.

`duplicate_of` is **not** in the `upsertBusiness` `set` clause, so a re-scan of a
marked dup's `osm_id` advances `lastSeenAt` and updates supplied fields without
clearing the marker — no churn.

### 5. Cartographer integration — `packages/agents/src/run-agent.ts`

On the **successful** completion path (the `status === "success"` branch, ~line
173, after the run loop), gated to `def.name === "cartographer"`: call
`dedupeBusinesses()` and log the `{ groups, marked }` summary. Failed runs skip
it. Deterministic — not exposed as an MCP tool, so the LLM cannot trigger or skip
it.

### One-time cleanup

After the migration, run `dedupeBusinesses()` once against the live DB to
collapse the existing Dorman pair (and any other latent dupes in the 367). A
tiny `scripts/dedupe-businesses.mjs` that imports and calls it, run once.

## Data flow

```
cartographer run (success)
  → run-agent.ts calls dedupeBusinesses()
      → read active, unmarked rows
      → groupDuplicates (name + 50m, transitive)
      → per group: chooseCanonical + mergeFacts + mark losers (txn)
  → losers now have duplicate_of set
dashboard / /businesses / list_businesses tool
  → listBusinesses() filters duplicate_of IS NULL
  → duplicates hidden from pins, directory, counts, and the agent
```

## Error handling

- Rows missing coordinates are left untouched (cannot confirm same place).
- The sweep is wrapped so a failure logs and does not fail the cartographer run
  (the run already succeeded; dedup is housekeeping).
- Re-running is safe and idempotent: marked rows are excluded from re-grouping.
- Un-merge is a manual `UPDATE ... SET duplicate_of = NULL` — reversible by design.

## Testing

Pure-module unit tests (`packages/db/src/dedupe.test.ts`):
- `normalizeName` — case/whitespace/trim.
- `metersBetween` — known distance; 50m boundary (just-inside vs just-outside).
- `groupDuplicates` — identical-coord pair groups; node/way ~10m pair groups;
  same name >50m apart does NOT group; different names at same point do NOT
  group; transitive chain; rows without coords excluded.
- `chooseCanonical` — richest wins; tie → oldest; final tie → lowest id.
- `mergeFacts` — fills only missing canonical fields; never overwrites.

Integration test (`packages/db/src/queries.test.ts`, in-memory DB):
- Dorman-shaped fixture (two rows, same name + same coords, one richer):
  `dedupeBusinesses()` marks the loser `duplicate_of = winner.osm_id`, the winner
  absorbs the loser's missing facts, and `listBusinesses()` returns only the
  winner (and `includeDuplicates: true` returns both).

## Out of scope (YAGNI)

- No write-time guard in the upsert hot path (the post-run sweep covers it).
- No tag union on merge (fill-missing only — simpler, predictable).
- No UI affordance to show "merged from N OSM records" (data supports it later).
- No automatic un-merge heuristics (manual SQL is enough).
