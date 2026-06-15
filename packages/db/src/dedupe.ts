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
  // Key on url + title together, not url alone: venue calendar/listing pages
  // host many distinct events at a single URL, and url-only keying collapses
  // them into one find (scout run #25 lost the source link off 11 of 12 saves
  // working around this). Title is still normalized, so utm/www/scheme URL
  // variants of the same titled event remain a single find.
  const basis = input.url
    ? `url:${normalizeUrl(input.url)}|title:${normalizeTitle(input.title)}`
    : `title:${normalizeTitle(input.title)}`;
  return createHash("sha256").update(basis).digest("hex");
}
