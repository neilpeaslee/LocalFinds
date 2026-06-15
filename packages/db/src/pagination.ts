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

// `matched` = number of items being paged. A non-positive or non-integer
// pageSize is coerced to 1 (same defensive treatment as `page`), so the window
// is never Infinity/NaN.
export function resolvePage(
  matched: number,
  page: number,
  pageSize: number,
): PageWindow {
  const size = Math.max(1, Math.trunc(pageSize) || 1);
  const pageCount = Math.max(1, Math.ceil(matched / size));
  const clamped = Math.min(Math.max(Math.trunc(page) || 1, 1), pageCount);
  const start = (clamped - 1) * size;
  const end = Math.min(start + size, matched);
  return { page: clamped, pageCount, start, end };
}
