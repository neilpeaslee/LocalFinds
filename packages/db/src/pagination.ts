// Pure pagination arithmetic for the ranked business directory. The ranked list
// is built and sorted in memory (tier comes from categories.json, not SQL), so
// paging is a slice of that sorted array. This turns a requested page into a
// clamped window over `matched` items.

export interface PageWindow {
  /** Clamped, 1-indexed current page. */
  page: number;
  /** Total number of pages (always >= 1). */
  pageCount: number;
  /** Slice start index, inclusive. */
  start: number;
  /** Slice end index, exclusive. */
  end: number;
}

// `matched` = number of items being paged. `pageSize` must be > 0.
export function resolvePage(
  matched: number,
  page: number,
  pageSize: number,
): PageWindow {
  const pageCount = Math.max(1, Math.ceil(matched / pageSize));
  const clamped = Math.min(Math.max(Math.trunc(page) || 1, 1), pageCount);
  const start = (clamped - 1) * pageSize;
  const end = Math.min(start + pageSize, matched);
  return { page: clamped, pageCount, start, end };
}
