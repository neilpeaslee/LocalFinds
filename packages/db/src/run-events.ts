// Per-run agent transcript: one structured event per line in
// data/agents/<agent>/runs/<runId>.jsonl. Powers the live SSE feed and the
// per-run detail page. Bulky transcripts stay under gitignored data/ (PII
// boundary); exact run stats stay in the `runs` table.

import fs from "node:fs";
import path from "node:path";
import { agentWorkspaceDir } from "./paths";

export type RunEvent =
  | {
      kind: "run_start";
      agent: string;
      runId: number;
      model: string;
      maxTurns: number;
      /** Reasoning effort, when the agent pins one; omitted = model default. */
      effort?: string;
    }
  | { kind: "assistant_text"; text: string }
  | { kind: "tool_use"; id: string; name: string; input: unknown }
  | { kind: "tool_result"; toolUseId: string; content: unknown; isError: boolean }
  | {
      kind: "result";
      subtype: string;
      numTurns: number;
      costUsd: number;
      usage: unknown;
      permissionDenials: unknown;
    }
  | { kind: "error"; message: string }
  | { kind: "run_end"; status: "success" | "error" };

// On disk and as read back: a RunEvent plus a per-run sequence number and an
// ISO timestamp, both stamped by the writer at append time.
export type StoredRunEvent = RunEvent & { seq: number; t: string };

// Project one SDK message to zero-or-more semantic events. Read defensively —
// the SDK message union is large and we only care about a few kinds.
export function projectMessage(message: any): RunEvent[] {
  if (!message || typeof message !== "object") return [];

  if (message.type === "assistant") {
    const out: RunEvent[] = [];
    for (const block of message.message?.content ?? []) {
      if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
        out.push({ kind: "assistant_text", text: block.text });
      } else if (block?.type === "tool_use") {
        out.push({ kind: "tool_use", id: block.id, name: block.name, input: block.input });
      }
    }
    return out;
  }

  if (message.type === "user") {
    const content = message.message?.content;
    if (!Array.isArray(content)) return [];
    const out: RunEvent[] = [];
    for (const block of content) {
      if (block?.type === "tool_result") {
        out.push({
          kind: "tool_result",
          toolUseId: block.tool_use_id,
          content: block.content,
          isError: block.is_error === true,
        });
      }
    }
    return out;
  }

  if (message.type === "result") {
    return [
      {
        kind: "result",
        subtype: message.subtype,
        numTurns: message.num_turns,
        costUsd: message.total_cost_usd,
        usage: message.modelUsage,
        permissionDenials: message.permission_denials,
      },
    ];
  }

  return [];
}

// Count tool-results the SDK flagged as errors — non-fatal failures (e.g. an
// aborted Overpass query) that would otherwise be invisible inside a run that
// still finishes "success". Surfaced as the run's warning count.
export function countRunWarnings(
  events: readonly { kind: string; isError?: boolean }[],
): number {
  return events.filter((e) => e.kind === "tool_result" && e.isError === true)
    .length;
}

export function runLogPath(agent: string, runId: number): string {
  return path.join(agentWorkspaceDir(agent), "runs", `${runId}.jsonl`);
}

// Turn a newly-read chunk into complete lines, carrying any trailing partial
// line forward in `rest`. Strips a trailing \r so CRLF is tolerated; drops
// blank lines.
export function splitLines(buffer: string, chunk: string): { lines: string[]; rest: string } {
  const parts = (buffer + chunk).split("\n");
  const rest = parts.pop() ?? "";
  const lines = parts.map((l) => l.replace(/\r$/, "")).filter((l) => l.length > 0);
  return { lines, rest };
}

export function parseEvents(text: string): StoredRunEvent[] {
  const lines = text.split("\n");
  const out: StoredRunEvent[] = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as StoredRunEvent);
    } catch {
      // The last non-empty line can be a legitimate partial from an in-flight
      // write — skip it silently. An unparseable interior line is real
      // corruption; skip it but warn so it isn't invisible in production.
      if (i < lines.length - 1) {
        console.warn(`run-events: skipping unparseable log line ${i + 1}`);
      }
    }
  }
  return out;
}

export function readRunEvents(agent: string, runId: number): StoredRunEvent[] {
  try {
    return parseEvents(fs.readFileSync(runLogPath(agent, runId), "utf8"));
  } catch {
    return [];
  }
}

export interface RunLogWriter {
  write(event: RunEvent): void;
  close(): void;
}

// Append-only JSONL writer. Stamps each event with a per-run sequence number
// and an ISO timestamp. appendFileSync per event keeps it crash-safe and avoids
// any buffer the SSE tailer would miss.
export function openRunLog(agent: string, runId: number): RunLogWriter {
  const file = runLogPath(agent, runId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let seq = 0;
  return {
    write(event: RunEvent) {
      const stored = { seq: seq++, t: new Date().toISOString(), ...event } as StoredRunEvent;
      fs.appendFileSync(file, JSON.stringify(stored) + "\n");
    },
    close() {},
  };
}
