import os from "node:os";
import fsx from "node:fs";
import pathx from "node:path";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  countRunWarnings,
  openRunLog,
  parseEvents,
  projectMessage,
  readRunEvents,
  runLogPath,
  splitLines,
} from "./run-events";

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

  it("skips an interior corrupt line (with a warning) but keeps good events", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const text =
      '{"seq":0,"t":"x","kind":"run_end","status":"success"}\nBADLINE\n{"seq":2,"t":"z","kind":"assistant_text","text":"ok"}';
    const events = parseEvents(text);
    expect(events.map((e) => e.seq)).toEqual([0, 2]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("readRunEvents", () => {
  it("returns [] when the log file does not exist", () => {
    expect(readRunEvents("no-such-agent", 99999)).toEqual([]);
  });
});

describe("openRunLog", () => {
  it("appends stamped events that readRunEvents can read back in order", () => {
    const tmp = fsx.mkdtempSync(pathx.join(os.tmpdir(), "lf-runlog-"));
    process.env.LOCALFINDS_DATA_DIR = tmp; // paths.ts honors this override
    try {
      const log = openRunLog("scout", 99);
      log.write({ kind: "run_start", agent: "scout", runId: 99, model: "claude-sonnet-4-6", maxTurns: 8 });
      log.write({ kind: "assistant_text", text: "hi" });
      log.write({ kind: "run_end", status: "success" });
      log.close();

      const events = readRunEvents("scout", 99);
      expect(events.map((e) => e.kind)).toEqual(["run_start", "assistant_text", "run_end"]);
      expect(events.map((e) => e.seq)).toEqual([0, 1, 2]);
      expect(typeof events[0].t).toBe("string");
    } finally {
      delete process.env.LOCALFINDS_DATA_DIR;
      fsx.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
