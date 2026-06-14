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
