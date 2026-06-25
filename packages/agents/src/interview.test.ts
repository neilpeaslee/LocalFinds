import { describe, expect, it } from "vitest";
import { QUESTIONNAIRE_TEMPLATE } from "./agents/interviewer";
import { isQuestionnaireFilled, lineDiff, parseInterviewArgs, sampleRunOptions } from "./interview";

describe("parseInterviewArgs", () => {
  it("defaults to the interactive path", () => {
    expect(parseInterviewArgs([])).toEqual({ prepared: false });
  });

  it("selects the prepared path on --prepared", () => {
    expect(parseInterviewArgs(["--prepared"])).toEqual({ prepared: true });
  });
});

describe("isQuestionnaireFilled", () => {
  it("treats the pristine template as unfilled", () => {
    expect(isQuestionnaireFilled(QUESTIONNAIRE_TEMPLATE)).toBe(false);
  });

  it("treats any non-empty Answer line as filled", () => {
    const filled = QUESTIONNAIRE_TEMPLATE.replace(
      "## 1. What do you offer?\nWhat product or service would you pitch to local businesses?\nAnswer:",
      "## 1. What do you offer?\nWhat product or service would you pitch to local businesses?\nAnswer: Websites for restaurants.",
    );
    expect(isQuestionnaireFilled(filled)).toBe(true);
  });
});

describe("lineDiff", () => {
  it("returns an empty string when nothing changed", () => {
    expect(lineDiff("a\nb\nc", "a\nb\nc")).toBe("");
  });

  it("shows removed lines with - and added lines with +, trimming common context", () => {
    const diff = lineDiff("name: Old\nbody\ntail", "name: New\nbody\ntail");
    expect(diff).toContain("- name: Old");
    expect(diff).toContain("+ name: New");
    expect(diff).not.toContain("body"); // unchanged context is trimmed
    expect(diff).not.toContain("tail");
  });

  it("treats a brand-new file (empty before) as all additions", () => {
    const diff = lineDiff("", "line1\nline2");
    expect(diff).toContain("+ line1");
    expect(diff).toContain("+ line2");
  });
});

describe("sampleRunOptions", () => {
  it("is small, low-effort, provisional, and points at the staging prospector workspace", () => {
    const opts = sampleRunOptions("/data/.staging-x");
    expect(opts.maxTurns).toBe(8);
    expect(opts.effort).toBe("low");
    expect(opts.findStatusOverride).toBe("provisional");
    expect(opts.workspaceDir).toBe("/data/.staging-x/agents/prospector");
  });
});
