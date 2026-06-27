// OpenStreetMap query client for the cartographer's osm_query tool. Thin HTTP
// client over the self-hosted PostGIS osm-api (which does the projection the
// retired overpass.ts used to do client-side). Pure logic + HTTP only (no
// SDK/db imports) so it stays unit-testable in isolation.

export const BUSINESS_KEYS = [
  "amenity",
  "shop",
  "tourism",
  "office",
  "craft",
  "leisure",
];

// OSM stable id, e.g. "node/123" / "way/456" / "relation/789" — the dedupe key.
const OSM_ID_RE = /^(?:node|way|relation)\/\d+$/;

export function isValidOsmId(osmId: string): boolean {
  return OSM_ID_RE.test(osmId.trim());
}

// The projected row the osm-api returns — exactly the shape upsert_businesses
// accepts (snake_case keys passed straight through to the tool).
export interface OsmBusiness {
  osm_id: string;
  name: string | null;
  lat: number | null;
  lng: number | null;
  kind: string | null;
  tags: string[];
  address: string | null;
  town: string | null;
  website: string | null;
  phone: string | null;
  brand: string | null;
}

// An MCP tool result: text content, optionally flagged as a failed call. A type
// alias (not an interface) so it keeps the implicit index signature the SDK's
// tool-handler return type requires.
export type ToolTextResult = {
  content: { type: "text"; text: string }[];
  isError?: true;
};

export interface OsmQueryParams {
  town?: string;
  bbox?: string; // "s,w,n,e"
  keys?: string[];
  limit?: number;
}

export type OsmResult =
  | { ok: true; elements: OsmBusiness[] }
  | { ok: false; error: string; status?: number };

const OSM_FAIL_HINT =
  "osm-api error or busy. Check one town/bbox + key at a time, then retry.";

type FetchLike = typeof fetch;

export async function runOsmQuery(
  params: OsmQueryParams,
  fetchImpl: FetchLike = fetch,
): Promise<OsmResult> {
  const base = process.env.OSM_API_BASE_URL;
  const token = process.env.OSM_API_TOKEN;
  if (!base || !token) {
    return { ok: false, error: "OSM_API_BASE_URL / OSM_API_TOKEN not configured" };
  }
  const qs = new URLSearchParams();
  if (params.town) qs.set("town", params.town);
  if (params.bbox) qs.set("bbox", params.bbox);
  if (params.keys?.length) qs.set("keys", params.keys.join(","));
  if (params.limit != null) qs.set("limit", String(params.limit));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 32_000);
  try {
    const res = await fetchImpl(`${base}/osm/businesses?${qs.toString()}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent":
          "LocalFinds/1.0 (cartographer agent; personal local-discovery directory)",
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, error: `osm-api HTTP ${res.status}`, status: res.status };
    }
    const json = (await res.json()) as OsmBusiness[];
    return { ok: true, elements: Array.isArray(json) ? json : [] };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

// Project a runOsmQuery result into the osm_query tool's response. A failed
// query returns isError:true so it surfaces as a real tool error in the run log
// and the run's warning count, while still carrying the retry hint. A success
// reports returned + a truncation guess (server already capped to `limit`).
export function formatOsmResult(
  result: OsmResult,
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
            hint: OSM_FAIL_HINT,
          }),
        },
      ],
      isError: true,
    };
  }
  const returned = result.elements.length;
  const cap = limit ?? 200;
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          returned,
          truncated: returned >= cap,
          elements: result.elements,
        }),
      },
    ],
  };
}
