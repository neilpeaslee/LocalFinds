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

  it("treats a whitespace-only q as no filter", () => {
    expect(filterSources(sources, { q: "   " }).length).toBe(2);
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
