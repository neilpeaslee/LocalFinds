import { describe, it, expect } from "vitest";
import { prospector } from "./agents/prospector";

describe("prospector coverage prompt", () => {
  it("instructs logging near-misses (skipped-but-notable businesses)", () => {
    const prompt = prospector.buildTaskPrompt({ region: "R", profile: "P", categories: "C" });
    expect(prompt.toLowerCase()).toContain("near-miss");
  });
});
