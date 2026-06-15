import { describe, expect, it } from "vitest";
import {
  formatOverpassResult,
  isValidOsmId,
  runOverpass,
  wrapOverpassQL,
} from "./overpass";

describe("wrapOverpassQL", () => {
  it("owns the settings header and out statement, stripping the agent's", () => {
    const out = wrapOverpassQL('[out:json][timeout:60]; nwr["shop"](area.a); out body;');
    expect(out.startsWith("[out:json][timeout:25];")).toBe(true);
    expect(out.trimEnd().endsWith("out tags center;")).toBe(true);
    expect(out).not.toContain("timeout:60");
    expect(out).not.toContain("out body");
    expect(out).toContain('nwr["shop"](area.a);');
  });

  it("does not corrupt a quoted value containing a scrub keyword", () => {
    const out = wrapOverpassQL('nwr["name"~"Out of the Blue"](area.a); out body;');
    expect(out).toContain('"Out of the Blue"');
    expect(out).toContain("(area.a)");
  });

  it("keeps a tag filter whose key resembles a setting keyword", () => {
    const out = wrapOverpassQL('nwr["amenity"="cafe"]["opening_date"="2020"](area.a);');
    expect(out).toContain('"opening_date"="2020"');
  });
});

describe("isValidOsmId", () => {
  it("accepts node/way/relation ids and rejects anything else", () => {
    expect(isValidOsmId("node/123")).toBe(true);
    expect(isValidOsmId("way/456")).toBe(true);
    expect(isValidOsmId("relation/789")).toBe(true);
    expect(isValidOsmId("node/12 ")).toBe(true); // trimmed
    expect(isValidOsmId("cafe Rockland")).toBe(false);
    expect(isValidOsmId("node/")).toBe(false);
    expect(isValidOsmId("https://x/node/1")).toBe(false);
  });
});

describe("formatOverpassResult", () => {
  it("flags a failed query as a tool error carrying the retry hint", () => {
    const out = formatOverpassResult({
      ok: false,
      error: "Overpass HTTP 504",
      status: 504,
    });
    expect(out.isError).toBe(true);
    const text = out.content[0].text;
    expect(text).toContain("Overpass HTTP 504");
    // the agent-facing hint must survive so it can still narrow + retry
    expect(text.toLowerCase()).toContain("narrow");
  });

  it("does not flag a successful query and returns only named, projected elements", () => {
    const out = formatOverpassResult({
      ok: true,
      elements: [
        { type: "node", id: 1, lat: 44, lon: -69, tags: { name: "Cafe", amenity: "cafe" } },
        { type: "node", id: 2, lat: 44, lon: -69, tags: { amenity: "bench" } }, // unnamed → dropped
      ],
    });
    expect(out.isError).toBeUndefined();
    const data = JSON.parse(out.content[0].text);
    expect(data.matched).toBe(1);
    expect(data.returned).toBe(1);
    expect(data.truncated).toBe(false);
    expect(data.elements[0].name).toBe("Cafe");
  });

  it("caps to the limit and reports truncation", () => {
    const elements = Array.from({ length: 5 }, (_, i) => ({
      type: "node" as const,
      id: i,
      lat: 44,
      lon: -69,
      tags: { name: `Park ${i}`, leisure: "park" },
    }));
    const data = JSON.parse(
      formatOverpassResult({ ok: true, elements }, 2).content[0].text,
    );
    expect(data.matched).toBe(5);
    expect(data.returned).toBe(2);
    expect(data.truncated).toBe(true);
  });
});

describe("runOverpass mirror fallback", () => {
  const okJson = () =>
    new Response(
      JSON.stringify({ elements: [{ type: "node", id: 1, tags: { name: "X" } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  it("falls through to the second mirror on a transient 5xx", async () => {
    let n = 0;
    const fakeFetch = (async () => {
      n++;
      return n === 1 ? new Response("busy", { status: 503 }) : okJson();
    }) as typeof fetch;
    const result = await runOverpass("nwr;", fakeFetch);
    expect(n).toBe(2);
    expect(result.ok).toBe(true);
  });

  it("does not retry a 400 query error (the other mirror would also reject it)", async () => {
    let n = 0;
    const fakeFetch = (async () => {
      n++;
      return new Response("bad query", { status: 400 });
    }) as typeof fetch;
    const result = await runOverpass("nwr;", fakeFetch);
    expect(n).toBe(1);
    expect(result.ok).toBe(false);
  });

  it("falls through when the first mirror returns a non-JSON 200", async () => {
    let n = 0;
    const fakeFetch = (async () => {
      n++;
      return n === 1
        ? new Response("<html>rate limited</html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          })
        : okJson();
    }) as typeof fetch;
    const result = await runOverpass("nwr;", fakeFetch);
    expect(n).toBe(2);
    expect(result.ok).toBe(true);
  });
});
