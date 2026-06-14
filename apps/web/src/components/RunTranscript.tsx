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
      return { icon: "•", text: ev.text.replace(/\s+/g, " ").trim().slice(0, 200) };
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
      return { icon: "✕", text: ev.message.replace(/\s+/g, " ").trim().slice(0, 200), error: true };
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
