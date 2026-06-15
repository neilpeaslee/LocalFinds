// View-side helpers for the /sources table. The summary is computed over the
// full source list (not the filtered set) so the header reads as a stable
// dashboard line; filtering and sorting are pure and unit-tested.
import type { Source } from "@localfinds/db";

export type SourceStatus = "active" | "paused" | "dead";
export const SOURCE_STATUSES: SourceStatus[] = ["active", "paused", "dead"];

export type SourceSort = "name" | "finds" | "quality" | "checked";
export type SortDir = "asc" | "desc";

export interface SourceSummary {
  total: number;
  byStatus: Record<SourceStatus, number>;
  totalFinds: number;
  avgQuality: number | null; // null when no source carries a quality score
}

export function summarizeSources(sources: Source[]): SourceSummary {
  const byStatus: Record<SourceStatus, number> = { active: 0, paused: 0, dead: 0 };
  let totalFinds = 0;
  let qualitySum = 0;
  let qualityCount = 0;
  for (const s of sources) {
    byStatus[s.status] += 1;
    totalFinds += s.findsCount;
    if (s.qualityScore != null) {
      qualitySum += s.qualityScore;
      qualityCount += 1;
    }
  }
  return {
    total: sources.length,
    byStatus,
    totalFinds,
    avgQuality: qualityCount > 0 ? qualitySum / qualityCount : null,
  };
}

export function filterSources(
  sources: Source[],
  opts: { q?: string; status?: SourceStatus },
): Source[] {
  const q = opts.q?.trim().toLowerCase();
  return sources.filter((s) => {
    if (opts.status && s.status !== opts.status) return false;
    if (q) {
      const hay = `${s.name ?? ""} ${s.url}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

// Stable sort by the chosen key/direction; returns a new array. Null sort
// values (missing quality or lastCheckedAt) always sort last, in both
// directions. The name key never produces null (falls back to the url).
export function sortSources(
  sources: Source[],
  sort: SourceSort,
  dir: SortDir,
): Source[] {
  const factor = dir === "asc" ? 1 : -1;
  const valueOf = (s: Source): string | number | null => {
    switch (sort) {
      case "name":
        return (s.name ?? s.url).toLowerCase();
      case "finds":
        return s.findsCount;
      case "quality":
        return s.qualityScore;
      case "checked":
        return s.lastCheckedAt;
    }
  };
  return [...sources].sort((a, b) => {
    const av = valueOf(a);
    const bv = valueOf(b);
    if (av == null && bv == null) return 0;
    if (av == null) return 1; // nulls last
    if (bv == null) return -1;
    if (av < bv) return -1 * factor;
    if (av > bv) return 1 * factor;
    return 0;
  });
}

export function parseSort(raw: string | undefined): SourceSort {
  return raw === "finds" || raw === "quality" || raw === "checked" ? raw : "name";
}

export function parseDir(raw: string | undefined): SortDir {
  return raw === "desc" ? "desc" : "asc";
}

export function parseStatus(raw: string | undefined): SourceStatus | undefined {
  return raw === "active" || raw === "paused" || raw === "dead" ? raw : undefined;
}
