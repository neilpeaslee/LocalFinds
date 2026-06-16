// Shared URL-building for the searchParams-driven pages (feed, businesses).
// `hrefWith` merges a patch onto the current params and drops empties, so default
// values stay implicit and URLs stay short.

export type Query = Record<string, string | undefined>;

// Next.js delivers string[] for a repeated query key (?q=a&q=b); take the first.
export function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function hrefWith(basePath: string, current: Query, patch: Query): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...current, ...patch })) {
    if (v) params.set(k, v);
  }
  const qs = params.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}
