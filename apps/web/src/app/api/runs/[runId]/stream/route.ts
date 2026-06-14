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
