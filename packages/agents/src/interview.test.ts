import { describe, expect, it } from "vitest";
import { QUESTIONNAIRE_TEMPLATE, collectionKickoff, reviewKickoff } from "./agents/interviewer";
import { isQuestionnaireFilled, lineDiff, parseInterviewArgs, preliminaryCycles, readMultilineAnswer, sampleRunOptions } from "./interview";

describe("readMultilineAnswer", () => {
  // Feed pre-set lines as if the user pressed Enter after each (last "" = blank submit).
  const feed = (lines: string[]) => {
    const q = [...lines];
    return readMultilineAnswer(async () => q.shift() ?? "");
  };

  it("joins a multi-line paste into one answer, ending on a blank line", async () => {
    expect(await feed(["line one", "line two", "line three", ""])).toBe(
      "line one\nline two\nline three",
    );
  });

  it("returns empty string on an immediate blank line", async () => {
    expect(await feed([""])).toBe("");
  });

  it("strips a trailing CR left by \\r\\n paste on each line", async () => {
    expect(await feed(["a\r", "b\r", ""])).toBe("a\nb");
  });

  it("preserves a single-line answer", async () => {
    expect(await feed(["just one line", ""])).toBe("just one line");
  });
});

describe("parseInterviewArgs", () => {
  it("defaults to the interactive path", () => {
    expect(parseInterviewArgs([])).toEqual({ prepared: false, depth: "brief" });
  });

  it("selects the prepared path on --prepared", () => {
    expect(parseInterviewArgs(["--prepared"])).toEqual({ prepared: true, depth: "brief" });
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

describe("interview depth", () => {
  it("parses --depth and maps to preliminary cycle counts", () => {
    expect(parseInterviewArgs([]).depth).toBe("brief");
    expect(parseInterviewArgs(["--depth=comprehensive"]).depth).toBe("comprehensive");
    expect(parseInterviewArgs(["--depth=nonsense"]).depth).toBe("brief");
    expect(preliminaryCycles("brief")).toBe(0);
    expect(preliminaryCycles("medium")).toBe(1);
    expect(preliminaryCycles("comprehensive")).toBe(2);
  });

  it("collectionKickoff folds review probes into the opening", () => {
    const out = collectionKickoff({
      reviewFindings: [
        { topic: "modern-site", observation: "skipped a real maker on web grounds", askUser: "Should a modern site disqualify?" },
      ],
    });
    expect(out).toContain("modern-site");
    expect(out).toContain("Should a modern site disqualify?");
  });
});

describe("reviewKickoff", () => {
  it("embeds the transcript + run facts and flags preliminary vs final", () => {
    const prelim = reviewKickoff({ transcript: "Q: a\nA: b", runId: 7, runStatus: "success", isFinal: false });
    expect(prelim).toContain("#7");
    expect(prelim).toContain("Q: a");
    expect(prelim).toContain("preliminary");

    const final = reviewKickoff({ transcript: "x", runId: 9, runStatus: "capped", isFinal: true });
    expect(final).toContain("FINAL");
    expect(final).toContain("empty probes");
  });
});
