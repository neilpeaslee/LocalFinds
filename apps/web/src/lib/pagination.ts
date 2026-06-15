// View-side pagination helpers for the /businesses directory. The query layer
// (packages/db) owns the slice math; this owns the URL page-size vocabulary and
// the numbered-pager sequence.

export type PageSize = 25 | 50 | 100 | "all";

export const PAGE_SIZES: PageSize[] = [25, 50, 100, "all"];

export const DEFAULT_PAGE_SIZE = 50;

// Parse a raw ?size= value. Unknown/missing -> the default (50).
export function parsePageSize(raw: string | undefined): PageSize {
  if (raw === "all") return "all";
  const n = Number(raw);
  return n === 25 || n === 50 || n === 100 ? n : DEFAULT_PAGE_SIZE;
}

// Numbered-pager sequence: always first + last, the current page +/- 1, and an
// "ellipsis" marker wherever a run of pages is collapsed.
export function pageWindow(
  page: number,
  pageCount: number,
): (number | "ellipsis")[] {
  if (pageCount <= 1) return [1];

  const wanted = new Set<number>([1, pageCount, page - 1, page, page + 1]);
  const ordered = [...wanted]
    .filter((p) => p >= 1 && p <= pageCount)
    .sort((a, b) => a - b);

  const out: (number | "ellipsis")[] = [];
  let prev = 0;
  for (const p of ordered) {
    if (p - prev > 1) out.push("ellipsis");
    out.push(p);
    prev = p;
  }
  return out;
}
