# Region map exploration — design

_Date: 2026-06-15_

> ## ⚠️ Flagged for rebuild review — client-side pin set (scales with region size)
>
> This design ships **every** map-eligible business to the browser once
> (`listMapPins`), then does all filtering / tier-by-zoom / budget / clustering
> **client-side**. Payload and client work scale with the region's business
> count, not with what's on screen.
>
> - **Why it's fine now:** one region, hundreds–low-thousands of pins, one user.
>   A few hundred annotated rows is tens of KB and trivial to filter in JS; it
>   makes pan/zoom/filter instant with zero round-trips.
> - **Why it won't scale:** a much larger region or the planned multi-user /
>   real-time rebuild makes the full-set ship + per-move client compute the
>   bottleneck. The scalable form is viewport-bounded server queries (bbox +
>   filters pushed to SQL, clustering server-side or via tile/vector endpoints).
> - **Revisit trigger:** same as the `/businesses` B1/B2 note — at the rebuild, or
>   sooner if a single region's pin count makes the initial load or pan/zoom
>   noticeable.

## Problem

The dashboard map (`apps/web/src/app/page.tsx` → `RegionMap`) renders every
business as one undifferentiated sky-blue dot, with a single show/hide toggle. At
~650 businesses it's an unreadable blob, and it currently shows only the first
**500** rows (`listBusinesses()`'s default `limit`, ordered by `(town, name)`),
so the alphabetically-last towns — Union, Vinalhaven, Waldoboro, Warren,
Washington — silently vanish from the map and the "businesses catalogued" stat.

We want the map to become a real **exploration tool**: filter by category and
tier and tags, color-coded pins, search, and a zoom-aware level of detail that
keeps the map legible from whole-region down to a single street — while still
conveying coverage. The existing 500-cap bug is fixed as a side effect (one
no-limit pin source feeds everything).

## Decisions (locked)

- **Purpose: an exploration tool**, not just a coverage overview. Pins are the
  point; the investment in filtering + zoom LOD + a legend is justified.
- **Placement: both surfaces (Option C).** A new full **`/map` page** holds the
  complete sidebar of filters; the **dashboard widget** keeps the new rendering
  (themed pins + coverage clusters, no cap) with a compact legend and an
  **"Explore map →"** link to `/map`.
- **Rendering model:** visible set = `categories ∩ subtypes ∩ tiers ∩ tags ∩
  status/chains`, restricted to the **viewport**. Of those, render **individual
  pins up to an adaptive budget**, filled **highest-tier-first**; **everything
  else becomes coverage clusters** (numbered neutral bubbles). No popularity
  ranking anywhere — so chains are never "promoted," they're just lower-tier
  dots/cluster members. This is the agreed answer to "what shows at wide zoom."
- **Adaptive budget**, scaled to viewport size, clamped to a floor/ceiling so the
  map is never empty or overwhelming.
- **Zoom drives the default tier selection**, mirrored in the tier checkboxes:
  wide zoom = top tier(s) only; **full zoom-in defaults to all _business_ tiers
  (1–3)**. **Tier 4 ("not a business") stays off by default** even at full zoom —
  consistent with the `/businesses` hide rule — but it is *listed* in the tier
  submenu so the user can opt in. (This is the explicit reading of "all tiers at
  full zoom" — flag at review if you'd rather Tier 4 auto-show when fully zoomed.)
  User can override any tier; override sticks until cleared.
- **Categories are curated themes with sub-types** (theme → kind), defined in a
  **render-time config** (`map-categories.json`), *not* a schema column — same
  pattern as `categories.json` for tiers. Honors the "no content taxonomy in the
  DB" principle.
- **Filters (all of them):** clickable category tree (theme + sub-type
  checkboxes), tag filter, status/chains toggles, name search, and the
  zoom-coupled tier submenu (collapsed, at the bottom, lists all tiers).
- **Pin color = theme.** Clusters are neutral gray (coverage, not a category).
- **Selection logic is a pure, unit-tested module**; React components stay thin.
- **Clustering via `supercluster`** (one new `apps/web` dependency).
- **Defaults match `/businesses`:** Tier 4 excluded, chains hidden, closed hidden
  — all toggleable.

## Data model & config

### Map-category config — `data/config/map-categories.json`

Gitignored (PII boundary), with a committed `.example`. Read at render time;
malformed/missing falls back to the `.example` then to a permissive default,
exactly like the existing `readCategoryConfig` / `readTownsConfig`.

```jsonc
{
  "themes": [
    {
      "key": "outdoors",
      "label": "Outdoors & Rec",
      "color": "#10b981",
      "subtypes": {
        "leisure=park": "Park",
        "leisure=dog_park": "Dog Park",
        "leisure=nature_reserve": "Nature Reserve",
        "leisure=slipway": "Slipway"
      }
    },
    { "key": "arts", "label": "Arts & Culture", "color": "#ec4899",
      "subtypes": { "tourism=museum": "Museum", "tourism=gallery": "Gallery",
                    "tourism=artwork": "Public Art", "amenity=arts_centre": "Arts Centre" } },
    { "key": "food", "label": "Food & Drink", "color": "#f59e0b",
      "subtypes": { "amenity=cafe": "Café", "amenity=restaurant": "Restaurant",
                    "amenity=bar": "Bar", "amenity=pub": "Pub" } },
    { "key": "retail", "label": "Shops & Retail", "color": "#8b5cf6", "subtypes": { "shop=*": "Shop" } },
    { "key": "civic", "label": "Civic & Services", "color": "#3b82f6",
      "subtypes": { "amenity=townhall": "Town Office", "amenity=school": "School",
                    "amenity=library": "Library", "amenity=fire_station": "Fire Station" } },
    { "key": "lodging", "label": "Lodging & Travel", "color": "#14b8a6",
      "subtypes": { "tourism=hotel": "Hotel", "tourism=guest_house": "Guest House" } },
    { "key": "cannabis", "label": "Cannabis", "color": "#65a30d",
      "subtypes": { "shop=cannabis": "Dispensary" } }
  ],
  "otherColor": "#64748b",
  "otherLabel": "Other"
}
```

- `subtypes` keys are OSM `kind` strings (`key=value`), with a `key=*` wildcard
  (matched after exact, like `tierOf`). Values are friendly sub-type labels.
- A `kind` matching no theme → the synthetic **"Other"** theme (`otherColor`).
- Sub-types are derived from config, so the legend tree is data-driven; adding an
  OSM kind to a theme needs no code change (mirrors the tier retuning story).

### `MapPin` — the annotated row the client works with

```ts
interface MapPin {
  id: number; name: string; kind: string | null;
  lat: number; lng: number; town: string | null;
  status: "active" | "closed" | "unknown";
  isChain: boolean;          // businesses.brand present
  tier: number;              // tierOf(kind)  — from categories.json
  theme: string;             // themeOf(kind).key — from map-categories.json ("other" fallback)
  subtype: string | null;    // friendly sub-type label, or null
  tags: string[];
}
```

## Architecture

Units, each with one job and a clear interface. The web app already has Vitest
(added with the run-warnings work), so no test-runner setup is needed.

### 1. Theme resolver — `packages/db/src/config.ts` (+ `config.test.ts`)

`readMapCategories(): MapCategoryConfig` (file → `.example` → default fallback
chain, matching the other readers) and a derived `themeOf(kind)` →
`{ key, label, color, subtype }`. Exact match first, then `key=*` wildcard, then
the "Other" theme. Lives in the db package beside `readCategoryConfig` so all
config-driven annotation is in one place.

### 2. Pin source — `packages/db/src/queries.ts` (+ `queries.test.ts`)

```ts
export function listMapPins(): MapPin[]
export function countBusinesses(): number   // count(*) where duplicate_of IS NULL
```

`countBusinesses` backs the dashboard's "businesses catalogued" stat — it counts
the whole catalogue (including coordinate-less rows `listMapPins` omits), so the
stat isn't undercounted by the pin set.

Selects coordinate-bearing, non-duplicate rows (`lat IS NOT NULL AND lng IS NOT
NULL AND duplicate_of IS NULL`), **no limit**, and annotates each with `tier`
(`tierOf`), `theme`/`subtype` (`themeOf`), and `isChain` (`brand` present). This
is the single source for both the dashboard widget and `/map` — and it is the fix
for the 500-cap bug.

### 3. Selection logic — `apps/web/src/lib/map-selection.ts` (+ `.test.ts`)

Pure, framework-free. The heart of the feature.

```ts
interface MapFilters {
  themes: Set<string>;                  // selected theme keys (empty = none shown)
  subtypes: Map<string, Set<string>>;   // theme key -> selected `kind`s (absent = all of that theme)
  tags: string[];                       // AND-of-tags (or single tag, see below)
  tiers: Set<number>;                   // effective tiers (zoom default merged with user override)
  showClosed: boolean;
  showChains: boolean;
  query: string;                        // name substring (case-insensitive)
}

interface Viewport { south: number; west: number; north: number; east: number;
                     widthPx: number; heightPx: number; }

// Default tier set for a zoom level, given which tiers exist in the data.
export function tiersForZoom(zoom: number, available: number[]): Set<number>;

// Adaptive pin budget for a viewport (clamped floor/ceiling).
export function budgetForViewport(widthPx: number, heightPx: number): number;

// The whole selection: filter -> sort by (tier, name) -> split at budget.
export function selectPins(
  pins: MapPin[], filters: MapFilters, viewport: Viewport,
): { shown: MapPin[]; overflow: MapPin[] };
```

`selectPins` algorithm:
1. **Filter** `pins` by: within `viewport` bounds; `theme ∈ filters.themes` (and
   sub-type ∈ the theme's selected set when one is given); `tier ∈ filters.tiers`;
   status (`showClosed` gates `closed`); chains (`showChains` gates `isChain`);
   `tags` (every requested tag present); `query` (name contains).
2. **Sort** the survivors by `(tier asc, name)`.
3. **Split**: `shown = survivors.slice(0, budget)`, `overflow = the rest`, where
   `budget = budgetForViewport(...)`.

`tiersForZoom`: a small monotonic step table (e.g. zoom ≤ Z1 → `{1}`; ≤ Z2 →
`{1,2}`; above → `{1,2,3}`). **Tier 4 is never auto-selected** (it's the
"not a business" bucket, opt-in only). Constants are tunable; the contract is
"monotonic, reaches all business tiers (1–3) at max zoom, intersected with
`available`, excludes Tier 4."

`budgetForViewport`: ~1 pin per `K` px² of map, clamped to `[MIN, MAX]` (e.g.
`MIN=15`, `MAX=60`). Constants tunable; contract is "more pins on a bigger
viewport, never below MIN or above MAX."

### 4. Clustering & map canvas — `apps/web/src/components/RegionMap.tsx`

Enhanced (not rewritten): keeps the coverage mask + town boundaries + framing.
New behavior:
- Takes `MapPin[]` + a `MapFilters` + an `onViewportChange`.
- On map `moveend`/`zoomend`, recompute `selectPins` for the current viewport.
- Render `shown` as **themed `CircleMarker`s** (color = theme color), `overflow`
  fed to **`supercluster`** → neutral gray numbered cluster bubbles; clicking a
  cluster zooms to its bounds.
- Pin click → popup: name, sub-type/kind, town, address, website, and a link to
  its `/businesses` entry.

### 5. `/map` page — `apps/web/src/app/map/page.tsx` + sidebar component

Server component loads `listMapPins()` + `readMapCategories()` and renders a
client shell: **sidebar** (filter state owner) + `RegionMap`. Sidebar order,
top → bottom: name search → **category tree** (theme checkbox + color swatch,
expandable to sub-type checkboxes; tri-state parent) → tag filter → show
closed/chains → **Tiers (collapsed, zoom-driven, all tiers)**. Collapses to a
drawer on mobile. Filter state lives in the client shell (URL-synced optional,
deferred — see Out of scope).

Tier control specifics: collapsed by default; expanded lists every tier present
in the data with live checkboxes; checkboxes default from `tiersForZoom(zoom)`
and show partial selection; toggling a tier sets a **manual override** that
persists until the user clears it (a "reset to auto" affordance reverts to the
zoom default).

### 6. Dashboard widget — `apps/web/src/app/page.tsx` + `RegionMapClient`

Switch its pin source from `listBusinesses()` to `listMapPins()` (**bug fix**).
The "businesses catalogued" stat must **not** use `listMapPins().length` — pins
exclude coordinate-less rows, which would undercount the catalogue; it uses a
dedicated non-duplicate `countBusinesses()` (a `count(*)` where
`duplicate_of IS NULL`). Render with the same `RegionMap` engine
but a **compact legend** (theme swatches, no full tree) and the **"Explore map
→"** link. Defaults: all themes on, tiers by zoom.

## Filter behavior details

- **Category tree:** unchecking a theme hides it; expanding shows sub-type
  checkboxes. Parent is tri-state (all / some / none). Default = all themes on.
- **Tags:** reuse the free-form tags already on rows. v1 = a single active tag (a
  chip cleared with ✕), consistent with `/businesses`; multi-tag AND is a natural
  later extension (the module already accepts an array).
- **Status/chains:** mirror `/businesses` — `closed` and `chains` off by default.
- **Name search:** case-insensitive substring; matches stay shown and the map can
  fly to a single match. Search narrows the candidate set before the budget.
- **Filter override at wide zoom:** because filters narrow the candidate set
  *before* the budget fills, a filtered map (e.g. only "Arts & Culture") shows
  every match as a real pin even zoomed out, since the survivor count is small.

## Edge cases

- **No pins at all** (cartographer hasn't run): existing empty-state message; map
  still frames the coverage area.
- **A `kind` in no theme:** falls to "Other" (gray); still appears, filterable
  via an "Other" legend entry.
- **A tier present in data but above the zoom default:** unchecked by default,
  appears in the tier list, user can opt in.
- **Empty viewport after filtering:** map shows clusters/pins = none; no error.
- **Malformed `map-categories.json`:** falls back to `.example` then default
  (never wipes the map), like the other config readers.
- **`supercluster` with 0 overflow:** no clusters rendered; all survivors are
  pins.

## Testing

TDD the pure units; components stay thin.

- **`config.test.ts`** (extend): `readMapCategories` fallback chain
  (file → `.example` → default), malformed JSON tolerated; `themeOf` exact match,
  `key=*` wildcard, "Other" fallback, sub-type label resolution.
- **`queries.test.ts`** (extend): `listMapPins` excludes duplicates and
  coordinate-less rows, annotates `tier`/`theme`/`subtype`/`isChain`, and returns
  **all** rows (regression guard for the 500-cap bug — assert a town beyond the
  old cutoff is present); `countBusinesses` counts non-duplicate rows including
  coordinate-less ones (i.e. can exceed `listMapPins().length`).
- **`apps/web/src/lib/map-selection.test.ts`** (new): `tiersForZoom`
  (monotonicity, all-at-max-zoom, intersect with available); `budgetForViewport`
  (scales with area, clamps to MIN/MAX); `selectPins` (viewport cull, each filter
  dimension, tier-then-name sort, budget split into shown/overflow, filter
  override yields all matches when survivors < budget).

No rendering tests for the React canvas/sidebar — the logic that can be wrong
lives in the pure module and the query.

## Phasing (for the implementation plan, not a scope cut)

1. **Phase 1 — core:** `listMapPins` (+ dashboard bug fix & stat), `readMapCategories`/`themeOf`,
   `map-selection` module, `supercluster`, `RegionMap` rendering (themed pins +
   clusters + tier-by-zoom + adaptive budget), compact dashboard legend.
2. **Phase 2 — full `/map`:** sidebar with category tree (sub-types), tag filter,
   status/chains toggles, name search, tier override UI, pin popups.

## Out of scope

- **Server-side viewport queries / clustering** (the scalable form flagged in the
  callout) — deferred to the rebuild.
- **URL-synced filter state** on `/map` (deep-linkable filters) — nice-to-have;
  start with in-component state.
- **Multi-tag AND** in the UI (module supports it; UI ships single-tag first).
- **Per-user persistence** of filter choices.
- **Heatmap / density shading** as an alternative to clusters.
- Editing/curating which businesses appear (this is a read/explore view).
