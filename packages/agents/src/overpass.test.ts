import { describe, expect, it } from "vitest";
import { isValidOsmId, runOverpass, wrapOverpassQL } from "./overpass";

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
