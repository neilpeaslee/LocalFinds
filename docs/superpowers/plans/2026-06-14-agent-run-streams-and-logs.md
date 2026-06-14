# Agent Run Streams and Logs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Watch an agent run live in the web UI and read any finished run's full transcript, both fed by one per-run structured event log.

**Architecture:** The runner already iterates the Agent SDK message stream; project each message to a JSON line in `data/agents/<agent>/runs/<runId>.jsonl`. An SSE route handler tails that file for the live feed; the same file backs a per-run detail page. One `RunTranscript` client component renders both. Pure logic (event projection, line splitting, parsing) lives in `@localfinds/db` and is unit-tested; I/O and UI get manual verification.

**Tech Stack:** TypeScript, Next.js 16 (App Router, route handlers, Server-Sent Events), Drizzle/SQLite, `@anthropic-ai/claude-agent-sdk`, vitest.

**Conventions:** Per repo memory, `git add` and `git commit` are **separate** commands (never combined). End every commit message with the trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` (omitted from the commands below for brevity — add it to each). Spec: `docs/superpowers/specs/2026-06-14-agent-run-streams-and-logs-design.md`.

---

## File Structure

**Create:**
- `packages/db/src/run-events.ts` — `RunEvent`/`StoredRunEvent` types, `projectMessage`, `runLogPath`, `splitLines`, `parseEvents`, `readRunEvents`, `openRunLog`.
- `packages/db/src/run-events.test.ts` — unit tests for the pure functions.
- `apps/web/src/app/api/runs/[runId]/stream/route.ts` — SSE tail endpoint.
- `apps/web/src/components/RunTranscript.tsx` — client component (live + static).
- `apps/web/src/app/agents/runs/[runId]/page.tsx` — per-run detail page.

**Modify:**
- `packages/db/src/index.ts` — re-export `run-events`.
- `packages/db/src/queries.ts` — add `getRun`.
- `packages/agents/src/run-agent.ts` — write events alongside the existing console logging.
- `apps/web/src/app/agents/page.tsx` — mount `RunTranscript` live; link run rows to the detail page; drop the `AutoRefresh` poll.

**Delete:**
- `apps/web/src/app/agents/AutoRefresh.tsx` — replaced by `RunTranscript`'s `run_end`-driven refresh.

---

## Task 1: Event types + `projectMessage` (pure, TDD)

**Files:**
- Create: `packages/db/src/run-events.ts`
- Test: `packages/db/src/run-events.test.ts`

`projectMessage` maps one SDK message to zero-or-more semantic events. Input is read defensively (structurally typed `any`), mirroring the existing `logMessage` in `run-agent.ts`. SDK shapes (verified against the installed `sdk.d.ts`): assistant messages carry `message.content[]` with `text`/`tool_use` blocks; user messages carry `message.content[]` with `tool_result` blocks (`tool_use_id`, `content`, `is_error`); the result message is `{ type: "result", subtype, num_turns, total_cost_usd, modelUsage, permission_denials }`.

- [ ] **Step 1: Write the failing test**

Create `packages/db/src/run-events.test.ts`:

```ts
import { describe, expect, it } from "vitest";
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- run-events`
Expected: FAIL — `Failed to resolve import "./run-events"` / `projectMessage is not a function`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/db/src/run-events.ts`:

```ts
// Per-run agent transcript: one structured event per line in
// data/agents/<agent>/runs/<runId>.jsonl. Powers the live SSE feed and the
// per-run detail page. Bulky transcripts stay under gitignored data/ (PII
// boundary); exact run stats stay in the `runs` table.

export type RunEvent =
  | { kind: "run_start"; agent: string; runId: number; model: string; maxTurns: number }
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- run-events`
Expected: PASS (6 tests in the `projectMessage` describe).

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/run-events.ts packages/db/src/run-events.test.ts
git commit -m "feat(db): RunEvent types + projectMessage (SDK message -> event)"
```

---

## Task 2: Path + line splitting + parsing (pure, TDD)

**Files:**
- Modify: `packages/db/src/run-events.ts`
- Test: `packages/db/src/run-events.test.ts`

`runLogPath` is the single source of truth for the file location (used by writer + both readers). `splitLines` is the byte-tail helper the SSE handler uses to turn appended chunks into complete lines, buffering any trailing partial line. `parseEvents`/`readRunEvents` turn a whole file into events, tolerating a trailing partial line from an in-flight write.

- [ ] **Step 1: Write the failing test**

Append to `packages/db/src/run-events.test.ts`:

```ts
import { parseEvents, runLogPath, splitLines } from "./run-events";

describe("runLogPath", () => {
  it("places the log under the agent workspace runs/ dir", () => {
    const p = runLogPath("scout", 42);
    expect(p.endsWith(["agents", "scout", "runs", "42.jsonl"].join(require("node:path").sep))).toBe(true);
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
    const text = '{"seq":0,"t":"x","kind":"run_end","status":"success"}\n{"seq":1,"t":"y","kind":"err';
    expect(parseEvents(text)).toEqual([
      { seq: 0, t: "x", kind: "run_end", status: "success" },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- run-events`
Expected: FAIL — `runLogPath`/`splitLines`/`parseEvents` are not exported.

- [ ] **Step 3: Write minimal implementation**

Add to the top of `packages/db/src/run-events.ts` (imports) and bottom (functions):

```ts
import fs from "node:fs";
import path from "node:path";
import { agentWorkspaceDir } from "./paths";
```

```ts
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
  const out: StoredRunEvent[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as StoredRunEvent);
    } catch {
      // tolerate a trailing partial line from an in-flight write
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- run-events`
Expected: PASS (all `run-events` describes).

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/run-events.ts packages/db/src/run-events.test.ts
git commit -m "feat(db): runLogPath, splitLines, parseEvents, readRunEvents"
```

---

## Task 3: `openRunLog` writer, `getRun`, package export

**Files:**
- Modify: `packages/db/src/run-events.ts`
- Modify: `packages/db/src/queries.ts:494` (add `getRun` near `listRuns`)
- Modify: `packages/db/src/index.ts`
- Test: `packages/db/src/run-events.test.ts`

The writer appends one stamped line per event (open/append per write — crash-safe, no buffering to flush; runs emit only tens–hundreds of events). `getRun` gives the readers the agent name + status for a `runId`.

- [ ] **Step 1: Write the failing test**

Append to `packages/db/src/run-events.test.ts`:

```ts
import { openRunLog, readRunEvents } from "./run-events";
import os from "node:os";
import fsx from "node:fs";
import pathx from "node:path";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- run-events`
Expected: FAIL — `openRunLog is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `packages/db/src/run-events.ts`:

```ts
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
```

Add `getRun` to `packages/db/src/queries.ts` immediately after `listRuns` (line 496). `db`, `runs`, and `eq` are already imported in this file:

```ts
export function getRun(id: number) {
  return db().select().from(runs).where(eq(runs.id, id)).get();
}
```

Add to `packages/db/src/index.ts` (alphabetical, after `./queries`):

```ts
export * from "./run-events";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — full db suite green, including the new `openRunLog` test.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/run-events.ts packages/db/src/queries.ts packages/db/src/index.ts packages/db/src/run-events.test.ts
git commit -m "feat(db): openRunLog writer + getRun query + export run-events"
```

---

## Task 4: Emit events from the runner (producer)

**Files:**
- Modify: `packages/agents/src/run-agent.ts`

Open the log right after `startRun`, write `run_start`, project each streamed message into the log alongside the existing `console.log`, and write `run_end` (and `error` on the catch path) **before** `finishRun` so the terminal marker is on disk before the DB row flips out of `running` (the SSE handler relies on this).

- [ ] **Step 1: Add the import**

In `packages/agents/src/run-agent.ts`, add `openRunLog` to the existing `@localfinds/db` import block (lines 2–9):

```ts
import {
  agentWorkspaceDir,
  finishRun,
  formatCategoryPriorities,
  openRunLog,
  readCategoryConfig,
  readRegionConfig,
  startRun,
} from "@localfinds/db";
```

- [ ] **Step 2: Open the log and write run_start**

Replace the existing line 104–105:

```ts
  const runId = startRun(def.name);
  console.log(`[${def.name}] run ${runId} starting (maxTurns=${maxTurns})`);
```

with:

```ts
  const runId = startRun(def.name);
  const log = openRunLog(def.name, runId);
  log.write({ kind: "run_start", agent: def.name, runId, model: "claude-sonnet-4-6", maxTurns });
  console.log(`[${def.name}] run ${runId} starting (maxTurns=${maxTurns})`);
```

- [ ] **Step 3: Project each message in the loop**

In the `for await` loop body (currently lines 138–139), add the projection import usage — replace:

```ts
      logMessage(message as never);
      if (message.type === "result") result = message;
```

with:

```ts
      logMessage(message as never);
      for (const ev of projectMessage(message)) log.write(ev);
      if (message.type === "result") result = message;
```

And add `projectMessage` to the `@localfinds/db` import from Step 1 (so the block lists `openRunLog, projectMessage`).

- [ ] **Step 4: Write run_end before finishRun (success path)**

In the `try` block, immediately after the `for await` loop closes and before the existing `finishRun(runId, {...})` call (line 142), insert:

```ts
    const status = result?.subtype === "success" ? "success" : "error";
    log.write({ kind: "run_end", status });
    log.close();
```

(The existing `finishRun` call stays as-is directly below — its `status` argument already computes the same value; leave it.)

- [ ] **Step 5: Write error + run_end before finishRun (catch path)**

In the `catch (err)` block, before the existing `finishRun(runId, {...})` call (line 156), insert:

```ts
    log.write({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    log.write({ kind: "run_end", status: "error" });
    log.close();
```

- [ ] **Step 6: Type-check the agents package**

Run: `npm -w @localfinds/agents exec tsc --noEmit -p tsconfig.json`
Expected: no errors. (If the agents package has no standalone `tsconfig.json`, run `npx tsc --noEmit` from the repo root instead.)

- [ ] **Step 7: Commit**

```bash
git add packages/agents/src/run-agent.ts
git commit -m "feat(agents): write per-run JSONL event log during runs"
```

---

## Task 5: SSE tail endpoint

**Files:**
- Create: `apps/web/src/app/api/runs/[runId]/stream/route.ts`

A Node-runtime route handler that streams `text/event-stream`: catch up on the file so far, then poll by byte offset (~700ms), emitting each new complete line. Closes on a `run_end` event, on the run leaving `running` (or going stale) once drained, or on client disconnect.

- [ ] **Step 1: Create the route handler**

Create `apps/web/src/app/api/runs/[runId]/stream/route.ts`:

```ts
import { getRun, isRunStale, runLogPath, splitLines } from "@localfinds/db";
import fs from "node:fs";

export const dynamic = "force-dynamic";

const POLL_MS = 700;

export async function GET(
  req: Request,
  ctx: { params: Promise<{ runId: string }> },
): Promise<Response> {
  const { runId: runIdStr } = await ctx.params;
  const runId = Number(runIdStr);
  const run = Number.isInteger(runId) ? getRun(runId) : undefined;
  if (!run) return new Response("run not found", { status: 404 });

  const file = runLogPath(run.agent, runId);
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let offset = 0;
      let buffer = "";
      let closed = false;

      const finish = () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      const poll = () => {
        if (closed) return;

        let size = 0;
        try {
          size = fs.statSync(file).size;
        } catch {
          // file not created yet (cold start) — fall through to the end check
        }

        if (size > offset) {
          const fd = fs.openSync(file, "r");
          const buf = Buffer.alloc(size - offset);
          fs.readSync(fd, buf, 0, buf.length, offset);
          fs.closeSync(fd);
          offset = size;

          const { lines, rest } = splitLines(buffer, buf.toString("utf8"));
          buffer = rest;
          for (const line of lines) {
            controller.enqueue(encoder.encode(`data: ${line}\n\n`));
            try {
              if ((JSON.parse(line) as { kind?: string }).kind === "run_end") {
                finish();
                return;
              }
            } catch {
              // non-JSON line — ignore for the end check
            }
          }
        }

        // Fallback close: the run is no longer live and we've drained the file.
        const fresh = getRun(runId);
        const ended = !fresh || fresh.status !== "running" || isRunStale(fresh, Date.now());
        if (ended && size <= offset) finish();
      };

      const timer = setInterval(poll, POLL_MS);
      poll(); // immediate first read (catch-up)
      req.signal.addEventListener("abort", finish);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
```

- [ ] **Step 2: Verify it builds and serves (manual)**

Run: `npm run dev`, then in another terminal:
`curl -N http://localhost:3000/api/runs/999999/stream`
Expected: HTTP 404 body `run not found` (no run with that id). For a real run id of a finished run, expect `data: {...}` lines for each stored event, then the stream closes. (Live behavior is verified end-to-end in Task 9.)

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/api/runs/[runId]/stream/route.ts
git commit -m "feat(web): SSE endpoint that tails a run's JSONL event log"
```

---

## Task 6: `RunTranscript` component (live + static)

**Files:**
- Create: `apps/web/src/components/RunTranscript.tsx`

One client component for both entry points. Fed `initialEvents`; if `live`, opens an `EventSource` to append the rest (deduping by `seq`, since the endpoint replays the whole file on connect), and on `run_end` closes the stream and calls `router.refresh()` once to update the summary table. Each row is curated, expandable to its full payload via `<details>`.

- [ ] **Step 1: Create the component**

Create `apps/web/src/components/RunTranscript.tsx`:

```tsx
"use client";

import type { StoredRunEvent } from "@localfinds/db";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

// `import type` above is erased at build time, so this client bundle never
// pulls in run-events.ts's node:fs dependency.

function brief(ev: StoredRunEvent): { icon: string; text: string; error?: boolean } {
  switch (ev.kind) {
    case "run_start":
      return { icon: "▶", text: `run started · ${ev.model} · maxTurns ${ev.maxTurns}` };
    case "assistant_text":
      return { icon: "•", text: ev.text.trim().slice(0, 200) };
    case "tool_use":
      return { icon: "→", text: `${ev.name} ${JSON.stringify(ev.input ?? {}).slice(0, 120)}` };
    case "tool_result":
      return { icon: "←", text: ev.isError ? "tool error" : "tool result", error: ev.isError };
    case "result":
      return {
        icon: ev.subtype === "success" ? "✓" : "✕",
        text: `${ev.subtype} · ${ev.numTurns} turns · $${(ev.costUsd ?? 0).toFixed(4)}`,
        error: ev.subtype !== "success",
      };
    case "error":
      return { icon: "✕", text: ev.message.slice(0, 200), error: true };
    case "run_end":
      return { icon: "■", text: `run ${ev.status}`, error: ev.status === "error" };
  }
}

function EventRow({ ev }: { ev: StoredRunEvent }) {
  const b = brief(ev);
  return (
    <details className="border-t border-stone-100 py-1 text-xs">
      <summary className="cursor-pointer list-none">
        <span className="mr-2 inline-block w-4 text-stone-400">{b.icon}</span>
        <span className={b.error ? "text-red-700" : "text-stone-700"}>{b.text}</span>
      </summary>
      <pre className="mt-1 overflow-x-auto rounded bg-stone-50 p-2 text-[11px] text-stone-600">
        {JSON.stringify(ev, null, 2)}
      </pre>
    </details>
  );
}

export function RunTranscript({
  runId,
  initialEvents = [],
  live = false,
}: {
  runId: number;
  initialEvents?: StoredRunEvent[];
  live?: boolean;
}) {
  const [events, setEvents] = useState<StoredRunEvent[]>(initialEvents);
  const bottomRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  useEffect(() => {
    if (!live) return;
    const es = new EventSource(`/api/runs/${runId}/stream`);
    es.onmessage = (e) => {
      let ev: StoredRunEvent;
      try {
        ev = JSON.parse(e.data);
      } catch {
        return;
      }
      setEvents((prev) => (prev.some((p) => p.seq === ev.seq) ? prev : [...prev, ev]));
      if (ev.kind === "run_end") {
        es.close();
        router.refresh();
      }
    };
    es.onerror = () => es.close();
    return () => es.close();
  }, [live, runId, router]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "nearest" });
  }, [events.length]);

  if (events.length === 0) {
    return (
      <p className="text-xs text-stone-500">
        {live ? "Waiting for the run to start…" : "No transcript recorded for this run."}
      </p>
    );
  }

  return (
    <div className="max-h-[28rem] overflow-y-auto rounded border border-stone-200 bg-white p-2 font-mono">
      {events.map((ev) => (
        <EventRow key={ev.seq} ev={ev} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
```

- [ ] **Step 2: Type-check the web package**

Run: `npm -w @localfinds/web exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/RunTranscript.tsx
git commit -m "feat(web): RunTranscript component (live + static, expandable rows)"
```

---

## Task 7: Per-run detail page

**Files:**
- Create: `apps/web/src/app/agents/runs/[runId]/page.tsx`

Server component: load the run row + its events, render a stats header and the transcript (live only if still running).

- [ ] **Step 1: Create the page**

Create `apps/web/src/app/agents/runs/[runId]/page.tsx`:

```tsx
import { getRun, isRunStale, readRunEvents, type Run } from "@localfinds/db";
import Link from "next/link";
import { notFound } from "next/navigation";
import { RunTranscript } from "@/components/RunTranscript";

export const dynamic = "force-dynamic";

function duration(run: Run): string {
  if (!run.finishedAt) return "—";
  return `${Math.round((+new Date(run.finishedAt) - +new Date(run.startedAt)) / 1000)}s`;
}

export default async function RunDetailPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId: runIdStr } = await params;
  const runId = Number(runIdStr);
  const run = Number.isInteger(runId) ? getRun(runId) : undefined;
  if (!run) notFound();

  const events = readRunEvents(run.agent, runId);
  const stale = isRunStale(run, Date.now());
  const live = run.status === "running" && !stale;

  return (
    <div className="flex flex-col gap-4">
      <Link href="/agents" className="text-xs text-stone-500 hover:underline">
        ← back to agents
      </Link>

      <div className="rounded-lg border border-stone-200 bg-white p-4">
        <h1 className="font-semibold">
          {run.agent} · run #{run.id}
        </h1>
        <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-stone-600 sm:grid-cols-3">
          <div>
            <dt className="text-stone-400">status</dt>
            <dd className={run.status === "success" ? "text-green-700" : run.status === "running" ? "text-amber-700" : "text-red-700"}>
              {stale ? "running — likely crashed" : run.status}
              {run.error ? ` (${run.error})` : ""}
            </dd>
          </div>
          <div>
            <dt className="text-stone-400">started</dt>
            <dd>{new Date(run.startedAt).toLocaleString()}</dd>
          </div>
          <div>
            <dt className="text-stone-400">duration</dt>
            <dd>{duration(run)}</dd>
          </div>
          <div>
            <dt className="text-stone-400">turns</dt>
            <dd>{run.numTurns ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-stone-400">added / updated</dt>
            <dd>+{run.itemsAdded} / ~{run.itemsUpdated}</dd>
          </div>
          <div>
            <dt className="text-stone-400">cost</dt>
            <dd>{run.costUsd != null ? `$${run.costUsd.toFixed(3)}` : "—"}</dd>
          </div>
        </dl>
      </div>

      <RunTranscript runId={run.id} initialEvents={events} live={live} />
    </div>
  );
}
```

- [ ] **Step 2: Type-check the web package**

Run: `npm -w @localfinds/web exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/agents/runs/[runId]/page.tsx
git commit -m "feat(web): per-run detail page with stats + transcript"
```

---

## Task 8: Wire into the agents page; drop AutoRefresh

**Files:**
- Modify: `apps/web/src/app/agents/page.tsx`
- Delete: `apps/web/src/app/agents/AutoRefresh.tsx`

Mount `RunTranscript` (live) for the in-progress run, make each history row link to the detail page, and remove the blind 4s `AutoRefresh` poll (the transcript now triggers a single refresh on `run_end`).

- [ ] **Step 1: Swap the imports**

In `apps/web/src/app/agents/page.tsx`, replace line 14 (`import { AutoRefresh } from "./AutoRefresh";`) with:

```tsx
import Link from "next/link";
import { RunTranscript } from "@/components/RunTranscript";
```

- [ ] **Step 2: Compute the active run id**

In `AgentsPage()`, just after `const inProgress = runInProgress(allRuns, now);` (line 95), add:

```tsx
  const activeRun = allRuns.find((r) => r.status === "running" && !isRunStale(r, now));
```

Add `isRunStale` to the `@localfinds/db` import block at the top of the file (it already imports `runInProgress`, `listRuns`, etc.; `isRunStale` is already imported for `RunRow`, so no change needed if present — confirm it is).

- [ ] **Step 3: Replace the AutoRefresh mount with the live transcript**

Replace line 99 (`<AutoRefresh active={inProgress} />`) with:

```tsx
      {activeRun && (
        <section className="rounded-lg border border-amber-200 bg-amber-50/40 p-4">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-amber-800">
              {activeRun.agent} running…
            </h2>
            <Link
              href={`/agents/runs/${activeRun.id}`}
              className="text-xs text-stone-500 hover:underline"
            >
              open run →
            </Link>
          </div>
          <RunTranscript runId={activeRun.id} live />
        </section>
      )}
```

- [ ] **Step 4: Link history rows to the detail page**

In `RunRow`, wrap the timestamp cell content (lines 58–60) in a link. Replace:

```tsx
      <td className="py-1 pr-3 whitespace-nowrap">
        {new Date(run.startedAt).toLocaleString()}
      </td>
```

with:

```tsx
      <td className="py-1 pr-3 whitespace-nowrap">
        <Link href={`/agents/runs/${run.id}`} className="text-stone-700 hover:underline">
          {new Date(run.startedAt).toLocaleString()}
        </Link>
      </td>
```

- [ ] **Step 5: Delete AutoRefresh**

```bash
git rm apps/web/src/app/agents/AutoRefresh.tsx
```

- [ ] **Step 6: Type-check the web package**

Run: `npm -w @localfinds/web exec tsc --noEmit`
Expected: no errors (no remaining references to `AutoRefresh`).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/app/agents/page.tsx
git commit -m "feat(web): live transcript on /agents + run links; drop AutoRefresh poll"
```

---

## Task 9: End-to-end verification + docs note

**Files:**
- Modify: `README.md` (one line under the agents section)

- [ ] **Step 1: Cheap fixture verification (no API spend)**

With `npm run dev` running, fabricate a run row + event log to exercise both readers without calling the SDK:

```bash
node -e '
const db = require("@localfinds/db");
const id = db.startRun("scout");
const log = db.openRunLog("scout", id);
log.write({ kind: "run_start", agent: "scout", runId: id, model: "claude-sonnet-4-6", maxTurns: 8 });
log.write({ kind: "tool_use", id: "tu_1", name: "WebSearch", input: { q: "demo" } });
log.write({ kind: "tool_result", toolUseId: "tu_1", content: "ok", isError: false });
log.write({ kind: "result", subtype: "success", numTurns: 2, costUsd: 0.01, usage: {}, permissionDenials: [] });
log.write({ kind: "run_end", status: "success" });
db.finishRun(id, { status: "success", numTurns: 2, costUsd: 0.01 });
console.log("run id:", id);
'
```

Open `http://localhost:3000/agents/runs/<id>` → confirm the stats header and an expandable transcript (rows expand to full JSON). Visit `/agents` → confirm the run is linked from its history row.

- [ ] **Step 2: Live verification (real run; spends a small budget)**

Requires `data/config/region.md` + a working `ANTHROPIC_API_KEY` (or Claude Code creds). On `/agents`, click **Run** on one agent. Expected: within ~10s a "running…" panel appears and events stream in live (curated rows, expandable); on completion the panel's `run_end` flips the history table to `success` without a manual reload. Open the finished run from history → full transcript renders statically.

- [ ] **Step 3: Confirm transcripts stay out of git**

Run: `git status --short`
Expected: no `data/agents/*/runs/*.jsonl` files appear (covered by the existing `data/**` gitignore). If any show, stop — the PII boundary is broken.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Add a README line**

Under the "Running agents" section of `README.md`, add:

```markdown
Watch a run live (or read any past run's full transcript) on `/agents` — each run
streams a structured event log to `data/agents/<agent>/runs/<id>.jsonl`, surfaced
via SSE and a per-run detail page.
```

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs: note live agent run streams + per-run transcripts"
```

---

## Self-Review

**Spec coverage:**
- Per-run JSONL event log under `data/agents/<agent>/runs/<id>.jsonl` → Tasks 1–4. ✓
- Curated, expandable rendering (full payload stored) → `RunTranscript` (Task 6) over `StoredRunEvent` carrying full fields (Task 1). ✓
- Live via SSE tail → Task 5 + Task 6 `EventSource`. ✓
- Read-one-run-deeply analysis → Task 7 detail page. ✓
- Shared seam (`runLogPath`/`getRun`/`readRunEvents`) → Tasks 2–3. ✓
- Drop the 4s AutoRefresh poll; refresh on `run_end` → Task 6 + Task 8. ✓
- Capture `tool_result` from user messages (which `logMessage` ignores) → `projectMessage` user branch (Task 1). ✓
- `run_end` written before `finishRun` (close-ordering the SSE relies on) → Task 4 Steps 4–5. ✓
- Unit-test the pure functions → Tasks 1–3 tests. ✓
- Out of scope (no cross-run analytics, search, retention, websockets, DB events table, backfill) → none added; "no transcript recorded" empty state covers un-backfilled old runs (Task 6). ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; commands have expected output. ✓

**Type consistency:** `RunEvent` / `StoredRunEvent` field names (`toolUseId`, `isError`, `numTurns`, `costUsd`, `permissionDenials`, `seq`, `t`) are identical across `projectMessage`, `openRunLog`, `readRunEvents`, the SSE handler, and `RunTranscript`. `getRun` returns the Drizzle `Run` row used by the route handler and detail page. `runLogPath(agent, runId)` signature is identical at every call site. ✓
