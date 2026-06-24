import { describe, expect, it } from "vitest";
import { geocodeTown, geocodeTowns } from "./geocode";

// A canned Nominatim /search response: a same-name decoy in another state
// (listed first) alongside the real Knox County, Maine administrative boundary.
// Nominatim's boundingbox is [south, north, west, east] (strings).
const ROCKLAND_PAYLOAD = [
  {
    class: "place",
    type: "town",
    lat: "42.1306",
    lon: "-70.9156",
    boundingbox: ["42.1000", "42.1600", "-70.9600", "-70.9000"],
    display_name: "Rockland, Plymouth County, Massachusetts",
  },
  {
    class: "boundary",
    type: "administrative",
    lat: "44.1037",
    lon: "-69.1089",
    boundingbox: ["44.0819", "44.1726", "-69.1853", "-69.0695"],
    display_name: "Rockland, Knox County, Maine, United States",
  },
];

function jsonFetch(payload: unknown, captured?: { url: string }): typeof fetch {
  return (async (url: string) => {
    if (captured) captured.url = String(url);
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

describe("geocodeTown", () => {
  it("prefers the administrative boundary over a same-name decoy listed first", async () => {
    const r = await geocodeTown(
      { name: "Rockland", county: "Knox County", state: "Maine" },
      jsonFetch(ROCKLAND_PAYLOAD),
    );
    expect("error" in r).toBe(false);
    if ("error" in r) throw new Error("expected a successful geocode");
    expect(r.lat).toBeCloseTo(44.1037);
    expect(r.lng).toBeCloseTo(-69.1089);
  });

  it("reorders Nominatim's [s,n,w,e] boundingbox to the project's [s,w,n,e]", async () => {
    const r = await geocodeTown(
      { name: "Rockland", county: "Knox County", state: "Maine" },
      jsonFetch(ROCKLAND_PAYLOAD),
    );
    if ("error" in r) throw new Error("expected a successful geocode");
    // Nominatim gave [44.0819(s), 44.1726(n), -69.1853(w), -69.0695(e)];
    // project order is [south, west, north, east].
    expect(r.bbox).toEqual([44.0819, -69.1853, 44.1726, -69.0695]);
  });

  it("builds the query 'name, county, state' and constrains to the US", async () => {
    const captured = { url: "" };
    await geocodeTown(
      { name: "Rockland", county: "Knox County", state: "Maine" },
      jsonFetch(ROCKLAND_PAYLOAD, captured),
    );
    const params = new URL(captured.url).searchParams;
    expect(params.get("q")).toBe("Rockland, Knox County, Maine");
    expect(params.get("countrycodes")).toBe("us");
    expect(params.get("format")).toBe("json");
  });

  it("uses the query override and omits county when absent", async () => {
    const captured = { url: "" };
    await geocodeTown(
      { name: "Matinicus Isle", query: "Matinicus Isle Plantation", state: "Maine" },
      jsonFetch(ROCKLAND_PAYLOAD, captured),
    );
    expect(new URL(captured.url).searchParams.get("q")).toBe(
      "Matinicus Isle Plantation, Maine",
    );
  });

  it("returns an error result (not a throw) when Nominatim finds nothing", async () => {
    const r = await geocodeTown({ name: "Nowheresville", state: "Maine" }, jsonFetch([]));
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.name).toBe("Nowheresville");
  });

  it("returns an error result on an HTTP failure", async () => {
    const failing = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    const r = await geocodeTown({ name: "Rockland", state: "Maine" }, failing);
    expect("error" in r).toBe(true);
  });

  it("falls back to the first result when no boundary is present", async () => {
    const placeOnly = [
      {
        class: "place",
        type: "village",
        lat: "44.5",
        lon: "-69.5",
        boundingbox: ["44.4", "44.6", "-69.6", "-69.4"],
        display_name: "Somewhere, Maine",
      },
    ];
    const r = await geocodeTown({ name: "Somewhere", state: "Maine" }, jsonFetch(placeOnly));
    if ("error" in r) throw new Error("expected a successful geocode");
    expect(r.bbox).toEqual([44.4, -69.6, 44.6, -69.4]);
  });
});

describe("geocodeTowns", () => {
  it("geocodes each town in order and one failure doesn't abort the batch", async () => {
    let call = 0;
    const fetchImpl = (async () => {
      call++;
      // first town: found; second: empty (no match)
      return new Response(JSON.stringify(call === 1 ? ROCKLAND_PAYLOAD : []), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const results = await geocodeTowns(
      [
        { name: "Rockland", county: "Knox County", state: "Maine" },
        { name: "Nowhere", state: "Maine" },
      ],
      { throttleMs: 0, fetchImpl },
    );

    expect(results).toHaveLength(2);
    expect("error" in results[0]).toBe(false);
    expect("error" in results[1]).toBe(true);
    expect(results[1].name).toBe("Nowhere");
  });
});
