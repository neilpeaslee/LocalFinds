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
  const n = nextId++;
  return {
    osmId: `way/${1000 + n}`,
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
    expect(chooseCanonical([closedRich, activeSparse]).osmId).toBe(activeSparse.osmId);
  });

  it("among same status, prefers the richest", () => {
    const sparse = row({});
    const rich = row({ website: "http://x.com" });
    expect(chooseCanonical([sparse, rich]).osmId).toBe(rich.osmId);
  });

  it("breaks ties (same status + richness) by lowest osm_id", () => {
    const a = row({ osmId: "way/100" });
    const b = row({ osmId: "way/200" });
    expect(chooseCanonical([b, a]).osmId).toBe("way/100");
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
