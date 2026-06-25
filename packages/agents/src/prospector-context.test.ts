import { describe, expect, it } from "vitest";
import { formatProspectorActivity, type ProspectorRunSummary } from "./prospector-context";

const RUNS: ProspectorRunSummary[] = [
  {
    id: 38,
    startedAt: "2026-06-24T18:00:00Z",
    status: "success",
    itemsAdded: 12,
    itemsUpdated: 3,
    warnings: 0,
  },
  {
    id: 37,
    startedAt: "2026-06-24T14:00:00Z",
    status: "success",
    itemsAdded: 20,
    itemsUpdated: 5,
    warnings: 2,
  },
];

describe("formatProspectorActivity", () => {
  it("summarizes recent runs and lead examples into a context block", () => {
    const out = formatProspectorActivity(RUNS, 41, ["Rock City Coffee", "Archipelago Gallery"]);
    expect(out).toContain("#38");
    expect(out).toContain("2026-06-24"); // date only, not the raw timestamp
    expect(out).not.toContain("T18:00:00Z");
    expect(out).toContain("+12");
    expect(out).toContain("2 warning"); // the run with warnings is surfaced
    expect(out).toContain("41"); // total lead count
    expect(out).toContain("Rock City Coffee");
  });

  it("returns an empty string on a cold start (no runs, no leads)", () => {
    expect(formatProspectorActivity([], 0, [])).toBe("");
  });
});
