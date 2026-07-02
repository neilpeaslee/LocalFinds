import { getRun, isRunStale, readRunEventsSince } from "@localfinds/db";

export const dynamic = "force-dynamic";

const POLL_MS = 700;

export async function GET(
  req: Request,
  ctx: { params: Promise<{ runId: string }> },
): Promise<Response> {
  const { runId: runIdStr } = await ctx.params;
  const runId = Number(runIdStr);
  const run = Number.isInteger(runId) ? await getRun(runId) : undefined;
  if (!run) return new Response("run not found", { status: 404 });

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let lastSeq = -1;
      let closed = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const finish = () => {
        if (closed) return;
        closed = true;
        if (timer) clearTimeout(timer);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      // Self-scheduling async poll: read the run_events rows newer than the last
      // seq we emitted, frame each as an SSE `data:` line, and stop when the run
      // ends (a run_end event, or the run is no longer live and drained).
      const poll = async () => {
        if (closed) return;

        const events = await readRunEventsSince(runId, lastSeq);
        for (const ev of events) {
          if (closed) return;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
          lastSeq = ev.seq;
          if (ev.kind === "run_end") {
            finish();
            return;
          }
        }

        // Fallback close: the run is no longer live and we've drained its events.
        const fresh = await getRun(runId);
        const ended = !fresh || fresh.status !== "running" || isRunStale(fresh, Date.now());
        if (ended && events.length === 0) {
          finish();
          return;
        }

        if (!closed) timer = setTimeout(poll, POLL_MS);
      };

      void poll(); // immediate first read (catch-up); schedules subsequent polls
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
