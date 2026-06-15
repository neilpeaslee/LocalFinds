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

  it("matches the name query case-insensitively regardless of input case", () => {
    const match = pin({ id: 1, name: "Keepers Cafe" });
    const miss = pin({ id: 2, name: "Other Place" });
    const { shown } = selectPins([match, miss], filters({ query: "KEEP" }), VIEW);
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
