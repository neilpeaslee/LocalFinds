import { describe, expect, it } from "vitest";
import { parseArgs, validateQueryUsage } from "./cli";

describe("parseArgs --query", () => {
  it("parses --query into opts.query alongside existing flags", () => {
    const { target, opts } = parseArgs([
      "concierge", "--query", "legal services", "--max-turns", "10",
    ]);
    expect(target).toBe("concierge");
    expect(opts.query).toBe("legal services");
    expect(opts.maxTurns).toBe(10);
  });

  it("still rejects unknown flags", () => {
    expect(() => parseArgs(["scout", "--bogus"])).toThrow(/Unknown argument/);
  });
});

describe("validateQueryUsage", () => {
  it("requires --query for concierge", () => {
    expect(validateQueryUsage("concierge", {})).toMatch(/requires --query/);
    expect(validateQueryUsage("concierge", { query: "  " })).toMatch(/requires --query/);
    expect(validateQueryUsage("concierge", { query: "legal services" })).toBeUndefined();
  });

  it("rejects --query for every other target (including all)", () => {
    expect(validateQueryUsage("scout", { query: "x" })).toMatch(/only valid/);
    expect(validateQueryUsage("all", { query: "x" })).toMatch(/only valid/);
    expect(validateQueryUsage("scout", {})).toBeUndefined();
  });
});
