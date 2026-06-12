import { createHash } from "node:crypto";

const TRACKING_PARAM = /^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$|ref$)/;

// Canonical form for exact dedupe: scheme dropped, www. and tracking params
// stripped, params sorted, no trailing slash. Same-event-different-URL cases
// are deliberately left to the curator agent's fuzzy pass.
export function normalizeUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return raw.trim().toLowerCase();
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const params = [...url.searchParams.entries()].filter(
    ([key]) => !TRACKING_PARAM.test(key.toLowerCase()),
  );
  params.sort(([a], [b]) => a.localeCompare(b));
  const query = new URLSearchParams(params).toString();
  const pathname = url.pathname.replace(/\/+$/, "");
  return `${host}${pathname}${query ? `?${query}` : ""}`;
}

export function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/\s+/g, " ").trim();
}

export function findKey(input: { url?: string | null; title: string }): string {
  const basis = input.url
    ? `url:${normalizeUrl(input.url)}`
    : `title:${normalizeTitle(input.title)}`;
  return createHash("sha256").update(basis).digest("hex");
}
