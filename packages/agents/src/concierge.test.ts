import { describe, expect, it } from "vitest";
import { concierge } from "./agents/concierge";
import { registry, rosterOrder } from "./cli";

const ctx = { region: "R", profile: "P", categories: "C", query: "legal services" };

describe("concierge definition", () => {
  it("is registered for on-demand use but stays off the schedule", () => {
    expect(registry.concierge).toBe(concierge);
    expect(rosterOrder).not.toContain("concierge");
  });

  it("carries the user's query verbatim in the task prompt", () => {
    expect(concierge.buildTaskPrompt(ctx)).toContain("legal services");
  });

  it("instructs the scan-tag convention and the report find", () => {
    const prompt = concierge.buildTaskPrompt(ctx);
    expect(prompt).toContain("scan:");
    expect(prompt).toContain('"report"');
  });

  it("restricts save_place to physically in-region businesses", () => {
    const prompt = concierge.buildTaskPrompt(ctx);
    expect(prompt.toLowerCase()).toContain("physically located");
  });

  it("has the on-demand tuning and the two place tools", () => {
    expect(concierge.defaultMaxBudgetUsd).toBe(2.0);
    expect(concierge.defaultMaxTurns).toBe(60);
    expect(concierge.effort).toBe("medium");
    expect(concierge.allowedTools).toContain("mcp__localfinds__save_place");
    expect(concierge.allowedTools).toContain("mcp__localfinds__annotate_place");
    expect(concierge.allowedTools).not.toContain("mcp__localfinds__update_find_status");
  });
});
