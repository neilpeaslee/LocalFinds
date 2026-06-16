// Ordering for the /businesses directory. The default (undefined sort) is the
// search-priority ranking — chains last, then tier, then name — shared by the
// directory page and the agents' list_businesses tool, so it must not drift.
// Any explicit sort overrides it. This lives in packages/db (not the web app)
// because sorting must run before pagination, which happens in
// listBusinessesRanked. The RankedBusiness import is type-only (erased), so
// there is no runtime import cycle with queries.ts.
import type { RankedBusiness } from "./queries";

export type BusinessSort = "tier" | "name" | "kind" | "town";
export type SortDir = "asc" | "desc";

const SORT_KEYS: BusinessSort[] = ["tier", "name", "kind", "town"];

// Default ranking, byte-for-byte identical to the prior inline comparator.
function rankCompare(a: RankedBusiness, z: RankedBusiness): number {
  return (
    Number(a.isChain) - Number(z.isChain) ||
    a.tier - z.tier ||
    a.business.name.localeCompare(z.business.name)
  );
}

export function sortRankedBusinesses(
  rows: RankedBusiness[],
  sort: BusinessSort | undefined,
  dir: SortDir,
): RankedBusiness[] {
  if (sort === undefined) return [...rows].sort(rankCompare);

  const factor = dir === "asc" ? 1 : -1;
  const valueOf = (r: RankedBusiness): string | number | null => {
    switch (sort) {
      case "tier":
        return r.tier;
      case "name":
        return r.business.name;
      case "kind":
        return r.business.kind;
      case "town":
        return r.business.town;
    }
  };

  return [...rows].sort((a, z) => {
    const av = valueOf(a);
    const bv = valueOf(z);
    // Nulls (missing kind/town) sort last, independent of direction.
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    const cmp =
      typeof av === "number" && typeof bv === "number"
        ? av - bv
        : String(av).localeCompare(String(bv));
    // Apply direction, then a stable name tiebreak.
    return cmp * factor || a.business.name.localeCompare(z.business.name);
  });
}

export function parseBusinessSort(raw: string | undefined): BusinessSort | undefined {
  return SORT_KEYS.includes(raw as BusinessSort) ? (raw as BusinessSort) : undefined;
}

export function parseDir(raw: string | undefined): SortDir {
  return raw === "desc" ? "desc" : "asc";
}
