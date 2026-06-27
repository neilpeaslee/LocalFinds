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
});
