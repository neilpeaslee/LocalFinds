import { describe, expect, it } from "vitest";
import type { Place } from "./schema";
import {
  parseBusinessSort,
  parseDir,
  sortRankedBusinesses,
} from "./business-sort";

// Build a RankedBusiness; only the fields the comparator reads need to vary.
function rb(
  over: Partial<Place> & { tier?: number; isChain?: boolean },
): { business: Place; tier: number; isChain: boolean } {
  const { tier = 1, isChain = false, ...bo } = over;
  const business: Place = {
    osmId: "node/1",
    name: "Business",
    kind: null,
    lat: null,
    lng: null,
    town: null,
    address: null,
    website: null,
    phone: null,
    brand: null,
    tags: [],
    status: "active",
    statusOverride: null,
    annotationNote: null,
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
