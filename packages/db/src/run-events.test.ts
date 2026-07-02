import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { resetDb, setupPgDatabase, teardownPgDatabase } from "../test/harness";
import {
  countRunWarnings,
  openRunLog,
  projectMessage,
  readRunEvents,
  readRunEventsSince,
} from "./run-events";
import { startRun } from "./queries";

beforeAll(setupPgDatabase, 120_000);
afterAll(teardownPgDatabase);
afterEach(resetDb);

describe("projectMessage", () => {
  it("emits text and tool_use events from an assistant message, in order", () => {
    const msg = {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Looking for markets" },
          { type: "tool_use", id: "tu_1", name: "WebSearch", input: { q: "farmers market" } },
        ],
      },
    };
    expect(projectMessage(msg)).toEqual([
      { kind: "assistant_text", text: "Looking for markets" },
      { kind: "tool_use", id: "tu_1", name: "WebSearch", input: { q: "farmers market" } },
    ]);
  });

  it("skips whitespace-only assistant text blocks", () => {
    const msg = { type: "assistant", message: { content: [{ type: "text", text: "   " }] } };
    expect(projectMessage(msg)).toEqual([]);
  });

  it("emits a tool_result event from a user message", () => {
    const msg = {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "tu_1", content: "3 results", is_error: false },
        ],
      },
    };
    expect(projectMessage(msg)).toEqual([
      { kind: "tool_result", toolUseId: "tu_1", content: "3 results", isError: false },
    ]);
  });

  it("marks tool_result errors", () => {
    const msg = {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "tu_2", content: "boom", is_error: true }] },
    };
    expect(projectMessage(msg)).toEqual([
      { kind: "tool_result", toolUseId: "tu_2", content: "boom", isError: true },
    ]);
  });

  it("emits a result event from the result message", () => {
    const msg = {
      type: "result",
      subtype: "success",
      num_turns: 7,
      total_cost_usd: 0.1234,
      modelUsage: { "claude-sonnet-4-6": { input: 1 } },
      permission_denials: [],
    };
    expect(projectMessage(msg)).toEqual([
      {
        kind: "result",
        subtype: "success",
        numTurns: 7,
        costUsd: 0.1234,
        usage: { "claude-sonnet-4-6": { input: 1 } },
        permissionDenials: [],
      },
    ]);
  });

  it("ignores other / malformed messages", () => {
    expect(projectMessage({ type: "system", subtype: "init" })).toEqual([]);
    expect(projectMessage(null)).toEqual([]);
    expect(projectMessage({ type: "user", message: {} })).toEqual([]);
  });
});

describe("countRunWarnings", () => {
  it("counts only tool-results the SDK flagged as errors", () => {
    const events = [
      { kind: "run_start" },
      { kind: "tool_result", isError: false },
      { kind: "tool_result", isError: true },
      { kind: "assistant_text" },
      { kind: "tool_result", isError: true },
    ];
    expect(countRunWarnings(events)).toBe(2);
  });

  it("is zero with no errored tool-results or no events", () => {
    expect(countRunWarnings([{ kind: "tool_result", isError: false }])).toBe(0);
    expect(countRunWarnings([])).toBe(0);
  });
});

describe("run_events store", () => {
  it("writes stamped events that readRunEvents reads back in order", async () => {
    const runId = await startRun("scout");
    const log = openRunLog("scout", runId);
    await log.write({ kind: "run_start", agent: "scout", runId, model: "claude-sonnet-4-6", maxTurns: 8 });
    await log.write({ kind: "assistant_text", text: "hi" });
    await log.write({ kind: "run_end", status: "success" });
    await log.close();

    const events = await readRunEvents(runId);
    expect(events.map((e) => e.kind)).toEqual(["run_start", "assistant_text", "run_end"]);
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(typeof events[0].t).toBe("string");
    // payload fields round-trip through jsonb
    const start = events[0];
    if (start.kind === "run_start") expect(start.model).toBe("claude-sonnet-4-6");
  });

  it("readRunEventsSince returns only events after the given seq", async () => {
    const runId = await startRun("scout");
    const log = openRunLog("scout", runId);
    await log.write({ kind: "run_start", agent: "scout", runId, model: "m", maxTurns: 8 });
    await log.write({ kind: "assistant_text", text: "a" });
    await log.write({ kind: "assistant_text", text: "b" });
    await log.close();

    expect((await readRunEventsSince(runId, 0)).map((e) => e.seq)).toEqual([1, 2]);
    expect(await readRunEventsSince(runId, 2)).toEqual([]);
  });

  it("readRunEvents returns [] for a run with no events", async () => {
    const runId = await startRun("prospector");
    expect(await readRunEvents(runId)).toEqual([]);
  });
});
