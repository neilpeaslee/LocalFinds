# Region Map Exploration — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the dashboard map into themed, zoom-aware pins + coverage clusters fed by a no-limit pin source — fixing the bug where alphabetically-last towns (Waldoboro, Warren, …) vanish past 500 rows.

**Architecture:** A render-time category config (`map-categories.json`) maps OSM `kind` → theme (color/label/sub-type). A new `listMapPins()` returns every coordinate-bearing, non-duplicate business annotated with tier + theme (no limit). A pure `map-selection` module filters by viewport/zoom/filters and splits results into "shown pins" (up to an adaptive budget, highest-tier-first) and "overflow" (clustered via `supercluster`). The `RegionMap` component renders themed `CircleMarker`s + gray count clusters, recomputing on pan/zoom. The dashboard widget consumes it with default filters and a compact legend.

**Tech Stack:** TypeScript, Drizzle (better-sqlite3), Next.js App Router, react-leaflet/Leaflet, supercluster, Vitest.

**Spec:** `docs/superpowers/specs/2026-06-15-region-map-exploration-design.md`. This plan implements **Phase 1** (core engine + bug fix + compact dashboard legend). Phase 2 (the `/map` page, full filter sidebar with the sub-type tree, tag filter, name search, tier-override UI, pin popups) gets its own plan after Phase 1 lands.

> **Spec refinement:** `MapPin` gains a `subtypeKey` field (the config key a pin matched, e.g. `"shop=*"` or `"leisure=park"`) in addition to the display `subtype` label. Sub-type *filtering* (Phase 2) matches on `subtypeKey`; the wildcard case (`shop=*` matching `shop=bakery`) can't be done on the label alone. Phase 1 builds and tests this but the UI doesn't expose sub-type filters yet.

**File structure (Phase 1):**
- `data/config/map-categories.json.example` — committed template for the theme map (create).
- `packages/db/src/config.ts` — add `readMapCategories()` + `themeOf()` (modify).
- `packages/db/src/config.test.ts` — tests for the above (modify).
- `packages/db/src/queries.ts` — add `MapPin`, `listMapPins()`, `countBusinesses()` (modify).
- `packages/db/src/queries.test.ts` — tests for the above (modify).
- `apps/web/src/lib/map-selection.ts` — pure selection module (create).
- `apps/web/src/lib/map-selection.test.ts` — tests (create).
- `apps/web/package.json` — add `supercluster` (modify).
- `apps/web/src/components/RegionMap.tsx` — themed pins + clusters + zoom selection (rewrite).
- `apps/web/src/app/page.tsx` — switch to `listMapPins`/`countBusinesses`, pass themes (modify).

---

## Task 1: Map-category config — `readMapCategories` + `themeOf`

**Files:**
- Create: `data/config/map-categories.json.example`
- Modify: `packages/db/src/config.ts`
- Test: `packages/db/src/config.test.ts`

- [ ] **Step 1: Create the committed template**

Create `data/config/map-categories.json.example`:

```json
{
  "themes": [
    { "key": "outdoors", "label": "Outdoors & Rec", "color": "#10b981",
      "subtypes": { "leisure=park": "Park", "leisure=dog_park": "Dog Park", "leisure=nature_reserve": "Nature Reserve", "leisure=slipway": "Slipway" } },
    { "key": "arts", "label": "Arts & Culture", "color": "#ec4899",
      "subtypes": { "tourism=museum": "Museum", "tourism=gallery": "Gallery", "tourism=artwork": "Public Art", "amenity=arts_centre": "Arts Centre" } },
    { "key": "food", "label": "Food & Drink", "color": "#f59e0b",
      "subtypes": { "amenity=cafe": "Café", "amenity=restaurant": "Restaurant", "amenity=bar": "Bar", "amenity=pub": "Pub" } },
    { "key": "retail", "label": "Shops & Retail", "color": "#8b5cf6",
      "subtypes": { "shop=*": "Shop" } },
    { "key": "civic", "label": "Civic & Services", "color": "#3b82f6",
      "subtypes": { "amenity=townhall": "Town Office", "amenity=school": "School", "amenity=library": "Library", "amenity=fire_station": "Fire Station" } },
    { "key": "lodging", "label": "Lodging & Travel", "color": "#14b8a6",
      "subtypes": { "tourism=hotel": "Hotel", "tourism=guest_house": "Guest House" } },
    { "key": "cannabis", "label": "Cannabis", "color": "#65a30d",
      "subtypes": { "shop=cannabis": "Dispensary" } }
  ],
  "otherKey": "other",
  "otherLabel": "Other",
  "otherColor": "#64748b"
}
```

- [ ] **Step 2: Write the failing tests**

Add to `packages/db/src/config.test.ts` — update the import line and append a describe block:

```ts
// at top, extend the existing import:
import { readMapCategories, readTownBoundaries, readTownsConfig } from "./config";
```

```ts
describe("readMapCategories / themeOf", () => {
  const cfgJson = JSON.stringify({
    themes: [
      { key: "outdoors", label: "Outdoors & Rec", color: "#10b981",
        subtypes: { "leisure=park": "Park", "leisure=dog_park": "Dog Park" } },
      { key: "retail", label: "Shops & Retail", color: "#8b5cf6", subtypes: { "shop=*": "Shop" } },
      { key: "cannabis", label: "Cannabis", color: "#65a30d", subtypes: { "shop=cannabis": "Dispensary" } },
    ],
    otherKey: "other", otherLabel: "Other", otherColor: "#64748b",
  });

  it("resolves an exact kind to its theme + sub-type", () => {
    writeConfig("map-categories.json", cfgJson);
    const r = readMapCategories().themeOf("leisure=dog_park");
    expect(r).toEqual({ key: "outdoors", label: "Outdoors & Rec", color: "#10b981",
      subtype: "Dog Park", subtypeKey: "leisure=dog_park" });
  });

  it("resolves a wildcard kind, keeping the wildcard as the sub-type key", () => {
    writeConfig("map-categories.json", cfgJson);
    const r = readMapCategories().themeOf("shop=bakery");
    expect(r).toMatchObject({ key: "retail", subtype: "Shop", subtypeKey: "shop=*" });
  });

  it("prefers an exact match over a wildcard (shop=cannabis -> cannabis, not retail)", () => {
    writeConfig("map-categories.json", cfgJson);
    expect(readMapCategories().themeOf("shop=cannabis").key).toBe("cannabis");
  });

  it("falls back to the Other theme for an unmapped or null kind", () => {
    writeConfig("map-categories.json", cfgJson);
    const cfg = readMapCategories();
    expect(cfg.themeOf("highway=residential")).toEqual({ key: "other", label: "Other",
      color: "#64748b", subtype: null, subtypeKey: null });
    expect(cfg.themeOf(null).key).toBe("other");
  });

  it("falls back to the .example when the real file is absent", () => {
    writeConfig("map-categories.json.example", cfgJson);
    expect(readMapCategories().themeOf("leisure=park").key).toBe("outdoors");
  });

  it("uses a safe default (everything -> Other) when no file is present", () => {
    const cfg = readMapCategories();
    expect(cfg.themes).toEqual([]);
    expect(cfg.themeOf("amenity=cafe").key).toBe("other");
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run packages/db/src/config.test.ts`
Expected: FAIL — `readMapCategories` is not exported / not a function.

- [ ] **Step 4: Implement `readMapCategories` + `themeOf`**

Add to `packages/db/src/config.ts` (after the `formatCategoryPriorities` function, or anywhere top-level):

```ts
// --- Map theme config (data/config/map-categories.json) ---
//
// Colors + groups OSM `kind`s into display themes for the region map's legend
// and pin colors. Render-time only (like categories.json tiers) — NOT a schema
// column, honoring "no content taxonomy in the DB".

export interface MapTheme {
  key: string;
  label: string;
  color: string;
  /** OSM "key=value" -> friendly sub-type label. "key=*" is a wildcard. */
  subtypes: Record<string, string>;
}

export interface ThemeMatch {
  key: string;
  label: string;
  color: string;
  /** Friendly sub-type label, or null when unmatched. */
  subtype: string | null;
  /** The config key matched (e.g. "shop=*" or "leisure=park"); null = Other. */
  subtypeKey: string | null;
}

export interface MapCategoryConfig {
  themes: MapTheme[];
  otherKey: string;
  otherLabel: string;
  otherColor: string;
  /** Resolve an OSM kind to its theme + sub-type (exact, then key=* wildcard, then Other). */
  themeOf(kind: string | null | undefined): ThemeMatch;
}

export function mapCategoriesPath(): string {
  return path.join(dataDir(), "config", "map-categories.json");
}

export function readMapCategories(): MapCategoryConfig {
  const file = mapCategoriesPath();
  let parsed: {
    themes?: MapTheme[];
    otherKey?: string;
    otherLabel?: string;
    otherColor?: string;
  } = {};
  for (const candidate of [file, `${file}.example`]) {
    let raw: string;
    try {
      raw = fs.readFileSync(candidate, "utf8");
    } catch {
      continue; // missing — try the next candidate
    }
    try {
      const json = JSON.parse(raw);
      if (json && typeof json === "object") {
        parsed = json;
        break; // accepted a well-formed candidate
      }
    } catch {
      // malformed JSON — fall through to the next candidate
    }
  }

  const themes = Array.isArray(parsed.themes) ? parsed.themes : [];
  const otherKey = parsed.otherKey ?? "other";
  const otherLabel = parsed.otherLabel ?? "Other";
  const otherColor = parsed.otherColor ?? "#64748b";

  // Build exact + wildcard lookups once. First theme to claim a key wins.
  const exact = new Map<string, { theme: MapTheme; label: string }>();
  const wild = new Map<string, { theme: MapTheme; label: string }>(); // "shop" -> ...
  for (const theme of themes) {
    for (const [k, label] of Object.entries(theme.subtypes ?? {})) {
      if (k.endsWith("=*")) {
        const key = k.slice(0, -2);
        if (!wild.has(key)) wild.set(key, { theme, label });
      } else if (!exact.has(k)) {
        exact.set(k, { theme, label });
      }
    }
  }

  const other: ThemeMatch = {
    key: otherKey, label: otherLabel, color: otherColor, subtype: null, subtypeKey: null,
  };

  const themeOf = (kind: string | null | undefined): ThemeMatch => {
    if (!kind) return other;
    const e = exact.get(kind);
    if (e) {
      return { key: e.theme.key, label: e.theme.label, color: e.theme.color,
        subtype: e.label, subtypeKey: kind };
    }
    const w = wild.get(kind.split("=")[0]);
    if (w) {
      return { key: w.theme.key, label: w.theme.label, color: w.theme.color,
        subtype: w.label, subtypeKey: `${kind.split("=")[0]}=*` };
    }
    return other;
  };

  return { themes, otherKey, otherLabel, otherColor, themeOf };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run packages/db/src/config.test.ts`
Expected: PASS (all describe blocks green).

- [ ] **Step 6: Commit**

```bash
git add data/config/map-categories.json.example packages/db/src/config.ts packages/db/src/config.test.ts
git commit -m "feat(db): map-categories config + themeOf resolver"
```

---

## Task 2: Pin source — `listMapPins` + `countBusinesses`

**Files:**
- Modify: `packages/db/src/queries.ts`
- Test: `packages/db/src/queries.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/db/src/queries.test.ts` (it already sets `LOCALFINDS_DATA_DIR` to a temp dir and pushes the schema in `beforeAll`; `q` is the imported `./queries` module). Note: `themeOf`/`tierOf` fall back to the permissive default in the temp dir (no config files), so `tier` will be the default tier and `theme` will be `"other"` — that's fine; this test asserts shape + filtering + no-limit, not specific tier/theme values.

```ts
describe("listMapPins / countBusinesses", () => {
  it("returns only coordinate-bearing, non-duplicate rows, annotated", () => {
    q.upsertBusiness({ osmId: "node/9001", name: "Has Coords", kind: "amenity=cafe",
      town: "Rockland", lat: 44.1, lng: -69.11, addedBy: "test" });
    q.upsertBusiness({ osmId: "node/9002", name: "No Coords", kind: "amenity=cafe",
      town: "Rockland", addedBy: "test" }); // lat/lng null -> excluded from pins
    q.upsertBusiness({ osmId: "node/9003", name: "Chain", kind: "shop=supermarket",
      town: "Rockland", lat: 44.2, lng: -69.2, brand: "Hannaford", addedBy: "test" });

    const pins = q.listMapPins();
    const byName = Object.fromEntries(pins.map((p) => [p.name, p]));
    expect(byName["No Coords"]).toBeUndefined();        // no coords -> not a pin
    expect(byName["Has Coords"]).toMatchObject({
      kind: "amenity=cafe", lat: 44.1, lng: -69.11, isChain: false,
      theme: "other", subtype: null, subtypeKey: null,
    });
    expect(typeof byName["Has Coords"].tier).toBe("number");
    expect(byName["Chain"].isChain).toBe(true);          // brand present
  });

  it("countBusinesses counts non-duplicate rows including coordinate-less ones", () => {
    const pins = q.listMapPins().length;
    const total = q.countBusinesses();
    expect(total).toBeGreaterThanOrEqual(pins); // counts rows pins omit (no coords)
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/db/src/queries.test.ts`
Expected: FAIL — `q.listMapPins is not a function`.

- [ ] **Step 3: Add `isNotNull` to the drizzle import**

In `packages/db/src/queries.ts`, update the first import line:

```ts
import { and, desc, eq, gte, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
```

And add `readMapCategories` to the config import:

```ts
import { readCategoryConfig, readMapCategories } from "./config";
```

- [ ] **Step 4: Implement `MapPin`, `listMapPins`, `countBusinesses`**

Add to `packages/db/src/queries.ts` (e.g. just before `listBusinessTowns`):

```ts
export interface MapPin {
  id: number;
  name: string;
  kind: string | null;
  lat: number;
  lng: number;
  town: string | null;
  status: "active" | "closed" | "unknown";
  isChain: boolean;
  /** Search-priority tier from categories.json. */
  tier: number;
  /** Theme key from map-categories.json ("other" fallback). */
  theme: string;
  /** Friendly sub-type label, or null. */
  subtype: string | null;
  /** Config key the kind matched (e.g. "shop=*"), for sub-type filtering. Null = Other. */
  subtypeKey: string | null;
  tags: string[];
}

// Every coordinate-bearing, non-duplicate business, annotated for the region map.
// No row limit — the single source for the dashboard map and the /map page.
export function listMapPins(): MapPin[] {
  const cfg = readCategoryConfig();
  const mapCfg = readMapCategories();
  const rows = db()
    .select()
    .from(businesses)
    .where(
      and(
        isNull(businesses.duplicateOf),
        isNotNull(businesses.lat),
        isNotNull(businesses.lng),
      ),
    )
    .all();
  return rows.map((b) => {
    const t = mapCfg.themeOf(b.kind);
    return {
      id: b.id,
      name: b.name,
      kind: b.kind,
      lat: b.lat as number,
      lng: b.lng as number,
      town: b.town,
      status: b.status,
      isChain: Boolean(b.brand),
      tier: cfg.tierOf(b.kind),
      theme: t.key,
      subtype: t.subtype,
      subtypeKey: t.subtypeKey,
      tags: b.tags,
    };
  });
}

// Total catalogued businesses (non-duplicate), incl. coordinate-less rows pins omit.
export function countBusinesses(): number {
  const row = db().get<{ n: number }>(
    sql`select count(*) as n from ${businesses} where ${businesses.duplicateOf} is null`,
  );
  return row?.n ?? 0;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run packages/db/src/queries.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/queries.ts packages/db/src/queries.test.ts
git commit -m "feat(db): listMapPins (no-limit, annotated) + countBusinesses"
```

---

## Task 3: Pure selection module — `map-selection.ts`

**Files:**
- Create: `apps/web/src/lib/map-selection.ts`
- Test: `apps/web/src/lib/map-selection.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/lib/map-selection.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { MapPin } from "@localfinds/db";
import {
  budgetForViewport,
  selectPins,
  tiersForZoom,
  type MapFilters,
  type Viewport,
} from "./map-selection";

function pin(over: Partial<MapPin>): MapPin {
  return {
    id: 1, name: "X", kind: "amenity=cafe", lat: 44.1, lng: -69.1, town: "Rockland",
    status: "active", isChain: false, tier: 1, theme: "food", subtype: "Café",
    subtypeKey: "amenity=cafe", tags: [], ...over,
  };
}

const VIEW: Viewport = { south: 44, west: -69.5, north: 44.3, east: -69, widthPx: 800, heightPx: 600 };

function filters(over: Partial<MapFilters> = {}): MapFilters {
  return {
    themes: new Set(["food", "outdoors", "other"]),
    subtypes: new Map(),
    tags: [],
    tiers: new Set([1, 2, 3]),
    showClosed: false,
    showChains: false,
    query: "",
    ...over,
  };
}

describe("tiersForZoom", () => {
  it("widens monotonically and reaches all business tiers at max zoom", () => {
    expect([...tiersForZoom(8, [1, 2, 3, 4])]).toEqual([1]);
    expect([...tiersForZoom(11, [1, 2, 3, 4])]).toEqual([1, 2]);
    expect([...tiersForZoom(16, [1, 2, 3, 4])]).toEqual([1, 2, 3]); // never auto-includes tier 4
  });
  it("intersects with the tiers actually present", () => {
    expect([...tiersForZoom(16, [1, 3])]).toEqual([1, 3]);
  });
});

describe("budgetForViewport", () => {
  it("clamps to the floor and ceiling", () => {
    expect(budgetForViewport(10, 10)).toBe(15);       // tiny -> floor
    expect(budgetForViewport(4000, 4000)).toBe(60);   // huge -> ceiling
  });
  it("scales with area between the bounds", () => {
    const b = budgetForViewport(600, 600); // 360000 / 9000 = 40
    expect(b).toBe(40);
  });
});

describe("selectPins", () => {
  it("culls pins outside the viewport", () => {
    const inside = pin({ id: 1, lat: 44.1, lng: -69.1 });
    const outside = pin({ id: 2, lat: 10, lng: 10 });
    const { shown } = selectPins([inside, outside], filters(), VIEW);
    expect(shown.map((p) => p.id)).toEqual([1]);
  });

  it("filters by theme, tier, status, chains, tags, and name query", () => {
    const keep = pin({ id: 1, name: "Keepers Cafe", theme: "food", tier: 1, tags: ["dog-friendly"] });
    const wrongTheme = pin({ id: 2, theme: "civic" });
    const wrongTier = pin({ id: 3, tier: 3 });
    const closed = pin({ id: 4, status: "closed" });
    const chain = pin({ id: 5, isChain: true });
    const noTag = pin({ id: 6, tags: [] });
    const wrongName = pin({ id: 7, name: "Other" });
    const f = filters({ tiers: new Set([1]), tags: ["dog-friendly"], query: "keep" });
    const { shown } = selectPins([keep, wrongTheme, wrongTier, closed, chain, noTag, wrongName], f, VIEW);
    expect(shown.map((p) => p.id)).toEqual([1]);
  });

  it("matches sub-types by subtypeKey, including the wildcard case", () => {
    const bakery = pin({ id: 1, theme: "retail", kind: "shop=bakery", subtypeKey: "shop=*" });
    const grocery = pin({ id: 2, theme: "retail", kind: "shop=grocery", subtypeKey: "shop=*" });
    const f = filters({ themes: new Set(["retail"]), subtypes: new Map([["retail", new Set(["shop=*"])]]) });
    const { shown } = selectPins([bakery, grocery], f, VIEW);
    expect(shown.map((p) => p.id)).toEqual([1, 2]); // both shops match the "shop=*" selection
  });

  it("sorts by tier then name and splits at the adaptive budget", () => {
    // Force budget 15 with a tiny viewport so the 16th pin overflows.
    const tinyView: Viewport = { ...VIEW, widthPx: 10, heightPx: 10 }; // budget = 15
    const pins = Array.from({ length: 20 }, (_, i) =>
      pin({ id: i + 1, name: `P${String(i).padStart(2, "0")}`, tier: i < 15 ? 1 : 2 }));
    const { shown, overflow } = selectPins(pins, filters(), tinyView);
    expect(shown).toHaveLength(15);
    expect(overflow).toHaveLength(5);
    expect(shown[0].tier).toBe(1); // tier 1 fills first
  });

  it("shows every match when survivors are under budget (filtered wide-zoom case)", () => {
    const a = pin({ id: 1, theme: "outdoors", name: "A Park" });
    const b = pin({ id: 2, theme: "outdoors", name: "B Park" });
    const { shown, overflow } = selectPins([a, b], filters({ themes: new Set(["outdoors"]) }), VIEW);
    expect(shown.map((p) => p.id)).toEqual([1, 2]);
    expect(overflow).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run apps/web/src/lib/map-selection.test.ts`
Expected: FAIL — cannot find module `./map-selection`.

- [ ] **Step 3: Implement the module**

Create `apps/web/src/lib/map-selection.ts`:

```ts
// Pure selection logic for the region map: given all pins + the current viewport
// + active filters, decide which render as individual pins (up to an adaptive,
// highest-tier-first budget) and which fall to coverage clusters. No React, no
// Leaflet — unit-tested in isolation.

import type { MapPin } from "@localfinds/db";

export interface MapFilters {
  /** Theme keys to show (a pin's `theme` must be in here). */
  themes: Set<string>;
  /** Per-theme selected sub-type keys; a theme absent here shows all its sub-types. */
  subtypes: Map<string, Set<string>>;
  /** Every listed tag must be present on the pin (AND). */
  tags: string[];
  /** Tiers to show (a pin's `tier` must be in here). */
  tiers: Set<number>;
  showClosed: boolean;
  showChains: boolean;
  /** Case-insensitive name substring; "" = no name filter. */
  query: string;
}

export interface Viewport {
  south: number;
  west: number;
  north: number;
  east: number;
  widthPx: number;
  heightPx: number;
}

// Zoom -> default visible tiers. Monotonic; reaches all *business* tiers (1–3) at
// high zoom. Tier 4 ("not a business") is never auto-selected (opt-in only).
const TIER_ZOOM_STEPS: ReadonlyArray<readonly [number, number[]]> = [
  [9, [1]],
  [11, [1, 2]],
];
const TIER_ZOOM_MAX = [1, 2, 3];

export function tiersForZoom(zoom: number, available: number[]): Set<number> {
  let tiers = TIER_ZOOM_MAX;
  for (const [maxZoom, t] of TIER_ZOOM_STEPS) {
    if (zoom <= maxZoom) {
      tiers = t;
      break;
    }
  }
  return new Set(tiers.filter((t) => available.includes(t)));
}

// Adaptive pin budget: ~1 pin per PX_PER_PIN of map area, clamped to [MIN, MAX].
const PX_PER_PIN = 9000;
const MIN_BUDGET = 15;
const MAX_BUDGET = 60;

export function budgetForViewport(widthPx: number, heightPx: number): number {
  const area = Math.max(0, widthPx) * Math.max(0, heightPx);
  return Math.max(MIN_BUDGET, Math.min(MAX_BUDGET, Math.round(area / PX_PER_PIN)));
}

function inBounds(p: MapPin, v: Viewport): boolean {
  return p.lat >= v.south && p.lat <= v.north && p.lng >= v.west && p.lng <= v.east;
}

function passesFilters(p: MapPin, f: MapFilters): boolean {
  if (!f.themes.has(p.theme)) return false;
  const subs = f.subtypes.get(p.theme);
  if (subs && subs.size > 0 && (p.subtypeKey === null || !subs.has(p.subtypeKey))) return false;
  if (!f.tiers.has(p.tier)) return false;
  if (!f.showClosed && p.status === "closed") return false;
  if (!f.showChains && p.isChain) return false;
  if (f.tags.length > 0 && !f.tags.every((t) => p.tags.includes(t))) return false;
  if (f.query && !p.name.toLowerCase().includes(f.query.toLowerCase())) return false;
  return true;
}

export function selectPins(
  pins: MapPin[],
  filters: MapFilters,
  viewport: Viewport,
): { shown: MapPin[]; overflow: MapPin[] } {
  const survivors = pins
    .filter((p) => inBounds(p, viewport) && passesFilters(p, filters))
    .sort((a, z) => a.tier - z.tier || a.name.localeCompare(z.name));
  const budget = budgetForViewport(viewport.widthPx, viewport.heightPx);
  return { shown: survivors.slice(0, budget), overflow: survivors.slice(budget) };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run apps/web/src/lib/map-selection.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/map-selection.ts apps/web/src/lib/map-selection.test.ts
git commit -m "feat(web): pure map-selection module (tier/zoom budget + filters)"
```

---

## Task 4: Add the `supercluster` dependency

**Files:**
- Modify: `apps/web/package.json` (+ `package-lock.json`)

- [ ] **Step 1: Install**

Run: `npm install -w @localfinds/web supercluster && npm install -w @localfinds/web -D @types/supercluster`
Expected: `apps/web/package.json` gains `supercluster` (dependencies) and `@types/supercluster` (devDependencies); `package-lock.json` updates.

- [ ] **Step 2: Verify the type resolves**

Run: `cd apps/web && npx tsc --noEmit -p tsconfig.json` (from repo root: `npx tsc --noEmit -p apps/web/tsconfig.json`)
Expected: exit 0 (no errors; the dep is installed even though nothing imports it yet).

- [ ] **Step 3: Commit**

```bash
git add apps/web/package.json package-lock.json
git commit -m "build(web): add supercluster for map clustering"
```

---

## Task 5: Render themed pins + coverage clusters in `RegionMap`

**Files:**
- Rewrite: `apps/web/src/components/RegionMap.tsx`

Keeps the coverage mask, town boundaries, and framing. Replaces the flat blue pin list with: viewport-tracked selection, themed `CircleMarker`s for shown pins, and gray count clusters (supercluster) for overflow. `RegionMapProps.businesses` becomes `MapPin[]`; a new `themes` prop carries colors/labels.

- [ ] **Step 1: Replace the file contents**

Replace `apps/web/src/components/RegionMap.tsx` with:

```tsx
"use client";

import "leaflet/dist/leaflet.css";
import type { MapPin } from "@localfinds/db";
import type { LatLngBoundsExpression, LatLngTuple } from "leaflet";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CircleMarker,
  MapContainer,
  Polygon,
  Rectangle,
  TileLayer,
  Tooltip,
  useMap,
  useMapEvents,
} from "react-leaflet";
import Supercluster from "supercluster";
import {
  budgetForViewport,
  selectPins,
  tiersForZoom,
  type MapFilters,
  type Viewport,
} from "@/lib/map-selection";

export interface TownBoxProp {
  name: string;
  bbox: [number, number, number, number];
  primary?: boolean;
}

export interface BoundaryFeature {
  type: "Feature";
  properties: { name: string; primary?: boolean; osm?: string };
  geometry: {
    type: "Polygon" | "MultiPolygon";
    coordinates: number[][][] | number[][][][];
  };
}

export interface MapThemeProp {
  key: string;
  label: string;
  color: string;
}

export interface RegionMapProps {
  towns: TownBoxProp[];
  boundaries: { features: BoundaryFeature[] };
  businesses: MapPin[];
  /** Theme key -> color/label, from readMapCategories (plus "other"). */
  themes: MapThemeProp[];
}

type Ring = LatLngTuple[];
type Vp = Viewport & { zoom: number };

const DEFAULT_CENTER: LatLngTuple = [44.1, -69.11];
const MASK_COLOR = "#1c1917";
const PRIMARY_COLOR = "#b45309";
const TOWN_COLOR = "#44403c";
const CLUSTER_FILL = "#64748b"; // slate-500
const CLUSTER_STROKE = "#475569"; // slate-600

function featureOuterRings(f: BoundaryFeature): Ring[] {
  const polys: number[][][][] =
    f.geometry.type === "Polygon"
      ? [f.geometry.coordinates as number[][][]]
      : (f.geometry.coordinates as number[][][][]);
  return polys
    .map((poly) => poly[0])
    .filter(Boolean)
    .map((ring) => ring.map(([lng, lat]) => [lat, lng] as LatLngTuple));
}

function bboxRing([s, w, n, e]: TownBoxProp["bbox"]): Ring {
  return [
    [s, w],
    [s, e],
    [n, e],
    [n, w],
  ];
}

// Once the map has fitted the coverage bounds, zoom in one extra level.
function ZoomInOne({ active }: { active: boolean }) {
  const map = useMap();
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (done || !active) return;
    setDone(true);
    map.setZoom(map.getZoom() + 1);
  }, [map, active, done]);
  return null;
}

// Emits the current viewport (bounds + pixel size + zoom) on load and after any
// pan/zoom, so the parent can recompute which pins to show.
function ViewportTracker({ onChange }: { onChange: (v: Vp) => void }) {
  const map = useMap();
  const emit = useCallback(() => {
    const b = map.getBounds();
    const s = map.getSize();
    onChange({
      south: b.getSouth(),
      west: b.getWest(),
      north: b.getNorth(),
      east: b.getEast(),
      widthPx: s.x,
      heightPx: s.y,
      zoom: map.getZoom(),
    });
  }, [map, onChange]);
  useMapEvents({ moveend: emit, zoomend: emit, load: emit });
  useEffect(() => {
    emit();
  }, [emit]);
  return null;
}

export default function RegionMap({ towns, boundaries, businesses, themes }: RegionMapProps) {
  const [vp, setVp] = useState<Vp | null>(null);

  const colorOf = useMemo(() => {
    const m = new Map(themes.map((t) => [t.key, t.color]));
    return (key: string) => m.get(key) ?? CLUSTER_FILL;
  }, [themes]);

  const availableTiers = useMemo(
    () => [...new Set(businesses.map((b) => b.tier))].sort((a, z) => a - z),
    [businesses],
  );

  // Phase 1 default filters: all themes on, tiers driven by zoom, no closed/chains.
  const { shown, overflow } = useMemo(() => {
    if (!vp) return { shown: [] as MapPin[], overflow: [] as MapPin[] };
    const filters: MapFilters = {
      themes: new Set([...themes.map((t) => t.key), "other"]),
      subtypes: new Map(),
      tags: [],
      tiers: tiersForZoom(vp.zoom, availableTiers),
      showClosed: false,
      showChains: false,
      query: "",
    };
    return selectPins(businesses, filters, vp);
  }, [vp, businesses, themes, availableTiers]);

  const clusters = useMemo(() => {
    if (!vp) return [];
    const index = new Supercluster({ radius: 60, maxZoom: 20 });
    index.load(
      overflow.map((p) => ({
        type: "Feature" as const,
        properties: { id: p.id },
        geometry: { type: "Point" as const, coordinates: [p.lng, p.lat] },
      })),
    );
    return index.getClusters([vp.west, vp.south, vp.east, vp.north], Math.round(vp.zoom));
  }, [overflow, vp]);

  const haveBoundary = new Set(boundaries.features.map((f) => f.properties.name));
  const fallbackTowns = towns.filter((t) => !haveBoundary.has(t.name));
  const coverageRings: Ring[] = [
    ...boundaries.features.flatMap(featureOuterRings),
    ...fallbackTowns.map((t) => bboxRing(t.bbox)),
  ];
  const bounds = computeBounds(coverageRings, businesses);
  const maskPositions: Ring[] = [
    [
      [85, -180],
      [85, 180],
      [-85, 180],
      [-85, -180],
    ],
    ...coverageRings,
  ];

  return (
    <div className="relative h-72 w-full sm:h-96">
      <MapContainer
        bounds={bounds}
        boundsOptions={{ padding: [16, 16] }}
        center={bounds ? undefined : DEFAULT_CENTER}
        zoom={bounds ? undefined : 11}
        scrollWheelZoom={false}
        className="h-full w-full overflow-hidden rounded-lg border border-stone-200"
      >
        <ZoomInOne active={Boolean(bounds)} />
        <ViewportTracker onChange={setVp} />
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        {coverageRings.length > 0 && (
          <Polygon
            positions={maskPositions}
            interactive={false}
            pathOptions={{ stroke: false, fillColor: MASK_COLOR, fillOpacity: 0.35 }}
          />
        )}

        {boundaries.features.map((f) =>
          featureOuterRings(f).map((ring, i) => (
            <Polygon
              key={`${f.properties.name}:${i}`}
              positions={ring}
              pathOptions={{
                color: f.properties.primary ? PRIMARY_COLOR : TOWN_COLOR,
                weight: f.properties.primary ? 2.5 : 1.5,
                fill: false,
              }}
            >
              <Tooltip direction="center" opacity={0.9}>
                {f.properties.name}
              </Tooltip>
            </Polygon>
          )),
        )}

        {fallbackTowns.map((t) => {
          const [s, w, n, e] = t.bbox;
          return (
            <Rectangle
              key={t.name}
              bounds={[
                [s, w],
                [n, e],
              ]}
              pathOptions={{
                color: t.primary ? PRIMARY_COLOR : TOWN_COLOR,
                weight: t.primary ? 2.5 : 1.5,
                dashArray: "4 3",
                fill: false,
              }}
            >
              <Tooltip direction="center" opacity={0.9}>
                {t.name}
              </Tooltip>
            </Rectangle>
          );
        })}

        {/* Coverage clusters (gray, numbered) for overflow */}
        {clusters.map((c) => {
          const [lng, lat] = c.geometry.coordinates;
          const props = c.properties as { cluster?: boolean; point_count?: number };
          if (!props.cluster) {
            // a lone overflow point — small muted dot
            return (
              <CircleMarker
                key={`pt-${(props as { id: number }).id}`}
                center={[lat, lng]}
                radius={3}
                pathOptions={{ color: CLUSTER_STROKE, fillColor: CLUSTER_FILL, fillOpacity: 0.7, weight: 1 }}
              />
            );
          }
          const count = props.point_count ?? 0;
          const radius = Math.min(24, 11 + Math.log2(count + 1) * 2.5);
          return (
            <CircleMarker
              key={`cl-${c.id}`}
              center={[lat, lng]}
              radius={radius}
              pathOptions={{ color: CLUSTER_STROKE, fillColor: CLUSTER_FILL, fillOpacity: 0.85, weight: 2 }}
            >
              <Tooltip direction="center" permanent opacity={1} className="lf-cluster-label">
                {count}
              </Tooltip>
            </CircleMarker>
          );
        })}

        {/* Shown pins, colored by theme */}
        {shown.map((b) => {
          const color = colorOf(b.theme);
          return (
            <CircleMarker
              key={b.id}
              center={[b.lat, b.lng]}
              radius={5}
              pathOptions={{ color, fillColor: color, fillOpacity: 0.9, weight: 1 }}
            >
              <Tooltip>
                <span className="font-medium">{b.name}</span>
                {b.subtype ? ` · ${b.subtype}` : b.kind ? ` · ${b.kind}` : ""}
              </Tooltip>
            </CircleMarker>
          );
        })}
      </MapContainer>

      {/* Compact legend */}
      <div className="absolute top-3 right-3 z-[1000] max-w-[10rem] rounded-md border border-stone-200 bg-white/95 p-2 text-xs text-stone-700 shadow-sm">
        <div className="mb-1 flex items-center gap-1.5">
          <span
            className="inline-block h-3 w-3 rounded-sm border-2"
            style={{ borderColor: PRIMARY_COLOR }}
          />
          <span>Coverage area</span>
        </div>
        {themes.map((t) => (
          <div key={t.key} className="flex items-center gap-1.5">
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: t.color }}
            />
            <span>{t.label}</span>
          </div>
        ))}
        <div className="mt-1 flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: CLUSTER_FILL }}
          />
          <span>more (zoom in)</span>
        </div>
      </div>
    </div>
  );
}

function computeBounds(rings: Ring[], businesses: MapPin[]): LatLngBoundsExpression | undefined {
  let south = Infinity;
  let west = Infinity;
  let north = -Infinity;
  let east = -Infinity;
  for (const ring of rings) {
    for (const [lat, lng] of ring) {
      south = Math.min(south, lat);
      west = Math.min(west, lng);
      north = Math.max(north, lat);
      east = Math.max(east, lng);
    }
  }
  if (!rings.length) {
    for (const b of businesses) {
      south = Math.min(south, b.lat);
      west = Math.min(west, b.lng);
      north = Math.max(north, b.lat);
      east = Math.max(east, b.lng);
    }
  }
  if (!Number.isFinite(south)) return undefined;
  return [
    [south, west],
    [north, east],
  ];
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p apps/web/tsconfig.json`
Expected: exit 0. (If `useMapEvents` or `Supercluster` types complain, confirm Task 4 installed `@types/supercluster` and that react-leaflet exports `useMapEvents` — it does in v4/v5.)

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/RegionMap.tsx
git commit -m "feat(web): themed pins + coverage clusters + zoom selection in RegionMap"
```

---

## Task 6: Wire the dashboard to the new pin source + themes

**Files:**
- Modify: `apps/web/src/app/page.tsx`

The home page currently calls `listBusinesses()` (the 500-cap bug) and maps it to pins. Switch to `listMapPins()` + `countBusinesses()` and pass `themes`.

- [ ] **Step 1: Update imports**

In `apps/web/src/app/page.tsx`, change the db import block to:

```ts
import {
  countBusinesses,
  getFeed,
  listMapPins,
  readMapCategories,
  readRegionConfig,
  readTownBoundaries,
  readTownsConfig,
} from "@localfinds/db";
```

(`listBusinesses` is no longer used here.)

- [ ] **Step 2: Replace the pin-building block**

Replace these lines:

```ts
  const allBusinesses = listBusinesses();
  const pins = allBusinesses
    .filter((b) => b.lat != null && b.lng != null)
    .map((b) => ({
      id: b.id,
      name: b.name,
      kind: b.kind,
      lat: b.lat as number,
      lng: b.lng as number,
      town: b.town,
    }));
```

with:

```ts
  const pins = listMapPins();
  const mapThemes = readMapCategories().themes.map((t) => ({
    key: t.key,
    label: t.label,
    color: t.color,
  }));
  const businessCount = countBusinesses();
```

- [ ] **Step 3: Pass `themes` to the map and fix the stat**

Update the `RegionMapClient` usage:

```tsx
      <RegionMapClient towns={towns} boundaries={boundaries} businesses={pins} themes={mapThemes} />
```

And change the "businesses catalogued" stat from the old `allBusinesses.length` to the real count:

```tsx
          <Stat label="businesses catalogued" value={businessCount} />
```

- [ ] **Step 4: Typecheck the web app**

Run: `npx tsc --noEmit -p apps/web/tsconfig.json`
Expected: exit 0.

- [ ] **Step 5: Manual verification — the bug is fixed and pins are themed**

Run the dev server (`npm run dev`) and open `http://localhost:3000`.
Confirm:
- The map shows **colored** pins (not all blue) and gray numbered **clusters**.
- **Zooming in** reveals more individual pins and shrinks clusters.
- Waldoboro/Warren now have pins (previously empty): in the browser, zoom into the Waldoboro area (≈44.1, −69.37) and confirm pins appear.
- The "businesses catalogued" stat reads the full count (e.g. ~651), not 500.

Quick HTML check (server is `force-dynamic`):
Run: `curl -s http://localhost:3000 | grep -o 'businesses catalogued' | head -1`
Expected: the label is present (visual count check is via the browser).

- [ ] **Step 6: Run the full test suite + commit**

Run: `npm test`
Expected: db + agents + web suites all pass (includes the new config/queries/map-selection tests).

```bash
git add apps/web/src/app/page.tsx
git commit -m "feat(web): dashboard map uses listMapPins (fixes 500-cap) + themed legend"
```

---

## Self-review notes (author)

- **Spec coverage (Phase 1 scope):** themed pins ✓ (Task 5), coverage clusters ✓ (Task 5, supercluster), adaptive budget + tier-by-zoom ✓ (Task 3 + Task 5), curated-theme config ✓ (Task 1), no-limit pin source + bug fix ✓ (Task 2 + Task 6), corrected "businesses catalogued" stat ✓ (Task 2 + Task 6), compact dashboard legend ✓ (Task 5). Phase 2 items (the `/map` page, sub-type tree UI, tag filter, name search, tier-override UI, pin popups, status/chains toggles) are intentionally deferred to the Phase 2 plan.
- **Type consistency:** `MapPin` (Task 2) is consumed unchanged by `map-selection` (Task 3) and `RegionMap` (Task 5). `MapFilters`/`Viewport` defined in Task 3 are the exact shapes Task 5 constructs. `MapThemeProp` (Task 5) is built from `readMapCategories().themes` (Task 1) in Task 6. `themeOf` returns `{ key, label, color, subtype, subtypeKey }` everywhere.
- **Tier 4:** never auto-selected by `tiersForZoom` (opt-in only), matching the spec decision.
```
