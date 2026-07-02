// Nominatim geocoder for the interviewer's set_towns flow. Pure HTTP + logic
// (no SDK/db imports) so it stays unit-testable in isolation, mirroring
// overpass.ts's injectable-fetchImpl pattern.
//
// This is NEW disambiguation logic, NOT a mirror of scripts/fetch-town-
// boundaries.mjs. That script picks a polygon by containment against an
// EXISTING towns.json bbox; this geocoder has no prior bbox (it runs for genuinely
// new towns) and instead leans on the query string (county + state) plus an
// admin-boundary preference. The two can therefore pick different OSM entities
// for the same name — which is exactly why set_towns must NOT re-geocode towns
// that already have a hand-tuned bbox.

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const UA =
  "LocalFinds/1.0 (interviewer agent; town geocoding; contact npeaslee@gmail.com)";

type FetchLike = typeof fetch;

export interface GeocodeInput {
  name: string;
  /** County context to disambiguate same-name towns (e.g. "Knox County"). */
  county?: string;
  state: string;
  /** Override the search term for odd names (e.g. "Matinicus Isle Plantation"). */
  query?: string;
}

export interface GeocodeOk {
  name: string;
  county?: string;
  /** Project order: [south, west, north, east]. */
  bbox: [number, number, number, number];
  lat: number;
  lng: number;
}

export interface GeocodeErr {
  name: string;
  error: string;
}

export type GeocodeResult = GeocodeOk | GeocodeErr;

// One Nominatim /search result we care about. Other fields are ignored.
interface NominatimResult {
  class?: string;
  type?: string;
  lat: string;
  lon: string;
  // [south, north, west, east] as strings.
  boundingbox: [string, string, string, string];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function searchUrl(input: GeocodeInput): string {
  // Mirror fetch-town-boundaries.mjs's query composition: county context
  // disambiguates collisions, an optional `query` override handles odd names.
  const where = input.county ? `${input.county}, ${input.state}` : input.state;
  const params = new URLSearchParams({
    q: `${input.query ?? input.name}, ${where}`,
    format: "json",
    countrycodes: "us",
    limit: "5",
  });
  return `${NOMINATIM}?${params}`;
}

// Prefer an administrative boundary, then any boundary, then the first result —
// the query's county/state context already narrows the candidate set.
function pick(results: NominatimResult[]): NominatimResult | undefined {
  return (
    results.find((r) => r.class === "boundary" && r.type === "administrative") ??
    results.find((r) => r.class === "boundary") ??
    results[0]
  );
}

export async function geocodeTown(
  input: GeocodeInput,
  fetchImpl: FetchLike = fetch,
): Promise<GeocodeResult> {
  let results: NominatimResult[];
  try {
    const res = await fetchImpl(searchUrl(input), { headers: { "User-Agent": UA } });
    if (!res.ok) {
      return { name: input.name, error: `Nominatim HTTP ${res.status}` };
    }
    results = (await res.json()) as NominatimResult[];
  } catch (err) {
    return { name: input.name, error: err instanceof Error ? err.message : String(err) };
  }

  const chosen = Array.isArray(results) ? pick(results) : undefined;
  if (!chosen || !chosen.boundingbox || chosen.boundingbox.length !== 4) {
    return { name: input.name, error: `No geocoding match for "${input.name}"` };
  }

  const nb = chosen.boundingbox.map(Number);
  // Nominatim: [south, north, west, east] → project: [south, west, north, east].
  const bbox: [number, number, number, number] = [nb[0], nb[2], nb[1], nb[3]];
  if (bbox.some((n) => !Number.isFinite(n))) {
    return { name: input.name, error: `Malformed boundingbox for "${input.name}"` };
  }

  return {
    name: input.name,
    ...(input.county ? { county: input.county } : {}),
    bbox,
    lat: Number(chosen.lat),
    lng: Number(chosen.lon),
  };
}

// Geocode towns sequentially, sleeping between calls (Nominatim allows ≤1 req/s).
// Per-town results so one failure doesn't abort the batch — the caller re-asks
// for the towns that came back with an error.
export async function geocodeTowns(
  inputs: GeocodeInput[],
  opts: { throttleMs?: number; fetchImpl?: FetchLike } = {},
): Promise<GeocodeResult[]> {
  const throttleMs = opts.throttleMs ?? 1100;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const out: GeocodeResult[] = [];
  for (let i = 0; i < inputs.length; i++) {
    out.push(await geocodeTown(inputs[i], fetchImpl));
    if (throttleMs > 0 && i < inputs.length - 1) await sleep(throttleMs);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Address-level geocoding (concierge save_place). Same Nominatim endpoint and
// injectable-fetch pattern as geocodeTown above; freeform q= (structured
// queries reject partial addresses more often). Callers own the ≤1 req/s
// throttle — this function performs exactly one request.

export interface AddressInput {
  housenumber?: string;
  street?: string;
  city: string;
  state?: string;
  postcode?: string;
}

export type AddressGeocodeResult =
  | { ok: true; lat: number; lng: number; displayName: string }
  | { ok: false; error: string };

export async function geocodeAddress(
  input: AddressInput,
  fetchImpl: FetchLike = fetch,
): Promise<AddressGeocodeResult> {
  const q = [
    [input.housenumber, input.street].filter(Boolean).join(" "),
    input.city,
    input.state ?? "ME",
    input.postcode,
  ]
    .filter((part) => part && String(part).trim() !== "")
    .join(", ");
  const params = new URLSearchParams({
    q,
    format: "json",
    countrycodes: "us",
    limit: "1",
  });
  let rows: { lat: string; lon: string; display_name?: string }[];
  try {
    const res = await fetchImpl(`${NOMINATIM}?${params}`, { headers: { "User-Agent": UA } });
    if (!res.ok) return { ok: false, error: `Nominatim HTTP ${res.status}` };
    rows = (await res.json()) as typeof rows;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const hit = Array.isArray(rows) ? rows[0] : undefined;
  if (!hit) return { ok: false, error: `No geocoding match for "${q}"` };
  const lat = Number(hit.lat);
  const lng = Number(hit.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { ok: false, error: `Malformed coordinates for "${q}"` };
  }
  return { ok: true, lat, lng, displayName: hit.display_name ?? q };
}
