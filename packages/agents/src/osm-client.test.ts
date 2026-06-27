import { describe, expect, it } from "vitest";
import {
  formatOsmResult,
  isValidOsmId,
  runOsmQuery,
  type OsmBusiness,
} from "./osm-client";

const sample: OsmBusiness = {
  osm_id: "node/1",
  name: "Rock City Coffee",
  lat: 44.1,
  lng: -69.11,
  kind: "amenity=cafe",
  tags: ["cafe", "coffee_shop"],
  address: "316 Main Street, Rockland",
  town: "Rockland",
  website: "https://rockcity.example",
  phone: "+1-207-555-0100",
  brand: "Rock City",
};

describe("isValidOsmId", () => {
  it("accepts node/way/relation ids and rejects anything else", () => {
    expect(isValidOsmId("node/123")).toBe(true);
    expect(isValidOsmId("way/456")).toBe(true);
    expect(isValidOsmId("relation/789")).toBe(true);
    expect(isValidOsmId("123")).toBe(false);
    expect(isValidOsmId("node/abc")).toBe(false);
  });
});

describe("runOsmQuery", () => {
  it("calls /osm/businesses with the bearer token and returns elements", async () => {
    process.env.OSM_API_BASE = "https://osm.example";
    process.env.OSM_API_TOKEN = "tok";
    let seenUrl = "";
    let seenAuth = "";
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      seenUrl = url;
      seenAuth = (init?.headers as Record<string, string>).Authorization;
      return new Response(JSON.stringify([sample]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const res = await runOsmQuery({ town: "Rockland", keys: ["amenity"] }, fakeFetch);
    expect(res).toEqual({ ok: true, elements: [sample] });
    expect(seenUrl).toContain("https://osm.example/osm/businesses");
    expect(seenUrl).toContain("town=Rockland");
    expect(seenUrl).toContain("keys=amenity");
    expect(seenAuth).toBe("Bearer tok");
  });

  it("returns an error result on a 5xx", async () => {
    process.env.OSM_API_BASE = "https://osm.example";
    process.env.OSM_API_TOKEN = "tok";
    const fakeFetch = (async () =>
      new Response("boom", { status: 503 })) as typeof fetch;
    const res = await runOsmQuery({ town: "Rockland" }, fakeFetch);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(503);
  });
});

describe("formatOsmResult", () => {
  it("flags a failed query as a tool error carrying a retry hint", () => {
    const out = formatOsmResult({ ok: false, error: "HTTP 503", status: 503 });
    expect(out.isError).toBe(true);
    const body = JSON.parse(out.content[0].text);
    expect(body.error).toBe("HTTP 503");
    expect(body.hint).toBeTruthy();
  });

  it("reports returned/truncated and passes elements through", () => {
    const out = formatOsmResult({ ok: true, elements: [sample, sample] }, 2);
    expect(out.isError).toBeUndefined();
    const body = JSON.parse(out.content[0].text);
    expect(body.returned).toBe(2);
    expect(body.truncated).toBe(true); // returned >= limit
    expect(body.elements).toHaveLength(2);
  });
});
