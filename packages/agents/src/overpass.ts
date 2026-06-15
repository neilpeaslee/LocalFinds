// OpenStreetMap / Overpass helpers used by the cartographer's overpass_query
// and upsert_business tools. Pure logic + HTTP only (no SDK/db imports) so it
// stays unit-testable in isolation.

// Public Overpass instances, tried in order on rate-limit/timeout/transient error.
export const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

// OSM top-level keys that denote a "business". First match becomes the `kind`.
export const BUSINESS_KEYS = [
  "amenity",
  "shop",
  "tourism",
  "office",
  "craft",
  "leisure",
];

export interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

// OSM stable id, e.g. "node/123" / "way/456" / "relation/789" — the dedupe key.
const OSM_ID_RE = /^(?:node|way|relation)\/\d+$/;

export function isValidOsmId(osmId: string): boolean {
  return OSM_ID_RE.test(osmId.trim());
}

export function primaryKind(tags: Record<string, string>): string | null {
  for (const key of BUSINESS_KEYS) {
    if (tags[key]) return `${key}=${tags[key]}`;
  }
  return null;
}

// A few lowercase free-form tags for filtering — the business-key values plus
// cuisine, capped. No controlled taxonomy; just useful chips.
export function tagList(tags: Record<string, string>): string[] {
  const out: string[] = [];
  for (const key of BUSINESS_KEYS) {
    if (tags[key]) out.push(...tags[key].split(";"));
  }
  if (tags.cuisine) out.push(...tags.cuisine.split(";"));
  return [
    ...new Set(out.map((t) => t.trim().toLowerCase()).filter(Boolean)),
  ].slice(0, 12);
}

export function composeAddr(tags: Record<string, string>): string | null {
  const street = [tags["addr:housenumber"], tags["addr:street"]]
    .filter(Boolean)
    .join(" ");
  const parts = [street, tags["addr:city"]].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

export function projectElement(el: OverpassElement) {
  const tags = el.tags ?? {};
  return {
    osmId: `${el.type}/${el.id}`,
    name: tags.name ?? null,
    lat: el.lat ?? el.center?.lat ?? null,
    lng: el.lon ?? el.center?.lon ?? null,
    kind: primaryKind(tags),
    tags: tagList(tags),
    website: tags.website ?? tags["contact:website"] ?? null,
    phone: tags.phone ?? tags["contact:phone"] ?? null,
    // brand present = national/regional chain (lowest search priority)
    brand: tags.brand ?? null,
    addr: composeAddr(tags),
  };
}

export type OverpassResult =
  | { ok: true; elements: OverpassElement[] }
  | { ok: false; error: string; status?: number };

// An MCP tool result: text content, optionally flagged as a failed call. A type
// alias (not an interface) so it keeps the implicit index signature the SDK's
// tool-handler return type requires.
export type ToolTextResult = {
  content: { type: "text"; text: string }[];
  isError?: true;
};

const OVERPASS_FAIL_HINT =
  "Query too large or Overpass is busy. Narrow to one business key and a single town/bbox, then retry.";

// Project a runOverpass result into the overpass_query tool's response. A failed
// query returns isError:true so it surfaces as a real tool error in the run log
// and the run's warning count — instead of being indistinguishable from a
// successful empty result — while still carrying the retry hint the agent acts
// on. A success is capped to `limit` named elements and flags truncation.
export function formatOverpassResult(
  result: OverpassResult,
  limit?: number,
): ToolTextResult {
  if (!result.ok) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: result.error,
            status: result.status,
            hint: OVERPASS_FAIL_HINT,
          }),
        },
      ],
      isError: true,
    };
  }
  const cap = Math.min(Math.max(limit ?? 80, 1), 150);
  const named = result.elements.map(projectElement).filter((e) => e.name);
  const elements = named.slice(0, cap);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          matched: named.length,
          returned: elements.length,
          truncated: named.length > cap,
          elements,
        }),
      },
    ],
  };
}

type FetchLike = typeof fetch;

export async function runOverpass(
  ql: string,
  fetchImpl: FetchLike = fetch,
): Promise<OverpassResult> {
  let last: OverpassResult = { ok: false, error: "no endpoints tried" };
  for (const endpoint of OVERPASS_ENDPOINTS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 32_000);
    try {
      const res = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent":
            "LocalFinds/1.0 (cartographer agent; personal local-discovery directory)",
        },
        body: new URLSearchParams({ data: ql }).toString(),
        signal: controller.signal,
      });
      if (!res.ok) {
        last = {
          ok: false,
          error: `Overpass HTTP ${res.status}`,
          status: res.status,
        };
        // 429 (rate limit) and 5xx (transient server error) → try next mirror.
        // Other 4xx are query/client errors the other mirror would also reject.
        if (res.status === 429 || res.status >= 500) continue;
        return last;
      }
      if (!(res.headers.get("content-type") ?? "").includes("json")) {
        // Some Overpass errors come back as a 200 with an HTML/text body —
        // give the next mirror a chance rather than giving up here.
        last = {
          ok: false,
          error: "Overpass returned a non-JSON body (query error or rate limit).",
        };
        continue;
      }
      const json = (await res.json()) as { elements?: OverpassElement[] };
      return { ok: true, elements: json.elements ?? [] };
    } catch (err) {
      // Network failure or client timeout → try the next mirror.
      last = { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  }
  return last;
}

// Strip any settings line / out statement the agent supplied; the tool owns
// those. Quoted string values are masked first, so a scrub keyword inside a
// value — e.g. ["name"="The Way Out"] or ["name"~"Out of the Blue"] — is never
// corrupted; only top-level settings/out statements are removed.
export function wrapOverpassQL(statement: string): string {
  const quoted: string[] = [];
  // Mask quoted spans with a sentinel (@ never appears in Overpass QL) so a
  // scrub keyword inside a value — ["name"="The Way Out"] — is never touched.
  const masked = statement.replace(/"(?:[^"\\]|\\.)*"/g, (m) => {
    quoted.push(m);
    return `@@${quoted.length - 1}@@`;
  });
  const scrubbed = masked
    // settings blocks use the colon syntax: [out:json] [timeout:25] [bbox:...]
    .replace(/\[(out|timeout|maxsize|bbox|diff|date):[^\]]*\]/gi, "")
    // any `out …` output statement, terminated by ; or end of input
    .replace(/\bout\b[^;]*(?:;|$)/gi, "")
    .replace(/^[\s;]+/, "")
    .trim();
  const body = scrubbed.replace(/@@(\d+)@@/g, (_, i) => quoted[Number(i)]);
  return `[out:json][timeout:25];\n${body.trim()}\nout tags center;`;
}
