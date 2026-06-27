import { describe, expect, it } from "vitest";
import { cartographer } from "./cartographer";

describe("cartographer definition", () => {
  it("uses the osm_query tool and not the retired overpass_query", () => {
    expect(cartographer.allowedTools).toContain("mcp__localfinds__osm_query");
    expect(cartographer.allowedTools).not.toContain(
      "mcp__localfinds__overpass_query",
    );
  });

  it("teaches osm_query (town/bbox + keys), not Overpass QL", () => {
    expect(cartographer.systemPrompt).toContain("osm_query");
    expect(cartographer.systemPrompt).not.toMatch(/overpass/i);
    expect(cartographer.systemPrompt).not.toContain("area[");
  });

  it("buildTaskPrompt contains no Overpass QL or 'overpass' references", () => {
    const prompt = cartographer.buildTaskPrompt({
      region: "Region briefing",
      profile: "profile",
      categories: "categories",
    });
    expect(prompt).not.toMatch(/overpass/i);
    expect(prompt).not.toContain("area[");
    expect(prompt).not.toContain("nwr[");
  });
});
