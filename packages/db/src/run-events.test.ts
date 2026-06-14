import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseEvents, readRunEvents, runLogPath, splitLines } from "./run-events";
import { projectMessage } from "./run-events";

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

describe("runLogPath", () => {
  it("places the log under the agent workspace runs/ dir", () => {
    expect(runLogPath("scout", 42)).toContain(
      path.join("agents", "scout", "runs", "42.jsonl"),
    );
  });
});

describe("splitLines", () => {
  it("returns complete lines and keeps a trailing partial in rest", () => {
    expect(splitLines("", '{"a":1}\n{"b":2}\n{"c"')).toEqual({
      lines: ['{"a":1}', '{"b":2}'],
      rest: '{"c"',
    });
  });

  it("joins a buffered partial with the next chunk", () => {
    const first = splitLines("", '{"a":1}\n{"b"');
    expect(first.lines).toEqual(['{"a":1}']);
    const second = splitLines(first.rest, ':2}\n');
    expect(second).toEqual({ lines: ['{"b":2}'], rest: "" });
  });

  it("drops blank lines and tolerates CRLF", () => {
    expect(splitLines("", '{"a":1}\r\n\n{"b":2}\r\n')).toEqual({
      lines: ['{"a":1}', '{"b":2}'],
      rest: "",
    });
  });
});

describe("parseEvents", () => {
  it("parses one event per line and skips a trailing partial line", () => {
    const text =
      '{"seq":0,"t":"x","kind":"run_end","status":"success"}\n{"seq":1,"t":"y","kind":"err';
    expect(parseEvents(text)).toEqual([
      { seq: 0, t: "x", kind: "run_end", status: "success" },
    ]);
  });
});
