// Per-run agent transcript: one structured event per row in
// localfinds.run_events — the single system of record. Powers the live SSE feed
// and the per-run detail page. Written as the run streams; read back ordered by
// the per-run sequence number. (Was a filesystem .jsonl before SP4.)

import { execute, query } from "./client";

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
  | { kind: "run_end"; status: "success" | "capped" | "error" };

// As read back: a RunEvent plus its per-run sequence number and an ISO timestamp
// (the run_events.seq / .t columns).
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

interface RunEventRow {
  seq: number;
  t: string;
  kind: string;
  payload: Record<string, unknown>;
}

// Reconstruct a StoredRunEvent from a row: kind/seq/t are columns; the event's
// remaining fields live in the payload jsonb (spread back on top).
function rowToEvent(r: RunEventRow): StoredRunEvent {
  return { ...r.payload, kind: r.kind, seq: r.seq, t: r.t } as unknown as StoredRunEvent;
}

export async function readRunEvents(runId: number): Promise<StoredRunEvent[]> {
  const rows = await query<RunEventRow>(
    `SELECT seq, t, kind, payload FROM localfinds.run_events WHERE run_id = $1 ORDER BY seq`,
    [runId],
  );
  return rows.map(rowToEvent);
}

// The events newer than `afterSeq` — the SSE poll's incremental read. Pass -1 to
// get everything from seq 0.
export async function readRunEventsSince(
  runId: number,
  afterSeq: number,
): Promise<StoredRunEvent[]> {
  const rows = await query<RunEventRow>(
    `SELECT seq, t, kind, payload FROM localfinds.run_events
     WHERE run_id = $1 AND seq > $2 ORDER BY seq`,
    [runId, afterSeq],
  );
  return rows.map(rowToEvent);
}

export interface RunLogWriter {
  write(event: RunEvent): Promise<void>;
  close(): Promise<void>;
}

// Row-per-event writer for the current run. Stamps a monotonic per-run sequence
// number; run_events.t defaults to now() on the DB (single clock). One INSERT per
// event is fine at this volume (single-user, tens–low-hundreds of events/run);
// batching/COPY is a future optimization, not built. `agent` is accepted for
// call-site symmetry — the (run_id, seq) key is all the writes need.
export function openRunLog(_agent: string, runId: number): RunLogWriter {
  let seq = 0;
  return {
    async write(event: RunEvent) {
      const { kind, ...payload } = event;
      await execute(
        `INSERT INTO localfinds.run_events (run_id, seq, kind, payload)
         VALUES ($1, $2, $3, $4)`,
        [runId, seq++, kind, JSON.stringify(payload)],
      );
    },
    async close() {},
  };
}
