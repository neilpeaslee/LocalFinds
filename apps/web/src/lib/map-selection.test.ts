import { describe, expect, it } from "vitest";
import type { MapPin } from "@localfinds/db";
import { selectVisible, tiersForZoom, type MapFilters, type Viewport } from "./map-selection";

function pin(over: Partial<MapPin>): MapPin {
  return {
    osmId: "node/1", name: "X", kind: "amenity=cafe", lat: 44.1, lng: -69.1, town: "Rockland",
    status: "active", isChain: false, tier: 1, theme: "food", subtype: "Café",
    subtypeKey: "amenity=cafe", tags: [], ...over,
  };
}

const VIEW: Viewport = { south: 44, west: -69.5, north: 44.3, east: -69 };

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

describe("selectVisible", () => {
  it("culls pins outside the viewport", () => {
    const inside = pin({ osmId: "node/1", lat: 44.1, lng: -69.1 });
    const outside = pin({ osmId: "node/2", lat: 10, lng: 10 });
    expect(selectVisible([inside, outside], filters(), VIEW).map((p) => p.osmId)).toEqual(["node/1"]);
  });

  it("filters by theme, tier, status, chains, tags, and name query", () => {
    const keep = pin({ osmId: "node/1", name: "Keepers Cafe", theme: "food", tier: 1, tags: ["dog-friendly"] });
    const wrongTheme = pin({ osmId: "node/2", theme: "civic" });
    const wrongTier = pin({ osmId: "node/3", tier: 3 });
    const closed = pin({ osmId: "node/4", status: "closed" });
    const chain = pin({ osmId: "node/5", isChain: true });
    const noTag = pin({ osmId: "node/6", tags: [] });
    const wrongName = pin({ osmId: "node/7", name: "Other" });
    const f = filters({ tiers: new Set([1]), tags: ["dog-friendly"], query: "keep" });
    const result = selectVisible([keep, wrongTheme, wrongTier, closed, chain, noTag, wrongName], f, VIEW);
    expect(result.map((p) => p.osmId)).toEqual(["node/1"]);
  });

  it("matches the name query case-insensitively regardless of input case", () => {
    const match = pin({ osmId: "node/1", name: "Keepers Cafe" });
    const miss = pin({ osmId: "node/2", name: "Other Place" });
    expect(selectVisible([match, miss], filters({ query: "KEEP" }), VIEW).map((p) => p.osmId)).toEqual(["node/1"]);
  });

  it("matches sub-types by subtypeKey, including the wildcard case", () => {
    const bakery = pin({ osmId: "node/1", theme: "retail", kind: "shop=bakery", subtypeKey: "shop=*" });
    const grocery = pin({ osmId: "node/2", theme: "retail", kind: "shop=grocery", subtypeKey: "shop=*" });
    const f = filters({ themes: new Set(["retail"]), subtypes: new Map([["retail", new Set(["shop=*"])]]) });
    expect(selectVisible([bakery, grocery], f, VIEW).map((p) => p.osmId)).toEqual(["node/1", "node/2"]);
  });

  it("returns every match with no cap (clustering, not a budget, controls density)", () => {
    const pins = Array.from({ length: 200 }, (_, i) => pin({ osmId: `node/${i + 1}`, lat: 44.1, lng: -69.1 }));
    expect(selectVisible(pins, filters(), VIEW)).toHaveLength(200);
  });
});
