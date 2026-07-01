import {
  countRunWarnings,
  getRun,
  isRunStale,
  readRunEvents,
} from "@localfinds/db";
import Link from "next/link";
import { notFound } from "next/navigation";
import { RunTranscript } from "@/components/RunTranscript";
import { duration } from "@/lib/run-utils";

export const dynamic = "force-dynamic";

export default async function RunDetailPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId: runIdStr } = await params;
  const runId = Number(runIdStr);
  const run = Number.isInteger(runId) ? await getRun(runId) : undefined;
  if (!run) notFound();

  const events = await readRunEvents(runId);
  // Compute from the log rather than the stored column so historical and live
  // runs both reflect their non-fatal tool failures accurately.
  const warnings = countRunWarnings(events);
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
            <dd
              className={
                run.status === "success"
                  ? "text-green-700"
                  : run.status === "running" || run.status === "capped"
                    ? "text-amber-700"
                    : "text-red-700"
              }
              title={
                run.status === "capped"
                  ? "stopped on its budget guardrail — results were saved"
                  : undefined
              }
            >
              {stale ? "running — likely crashed" : run.status}
              {run.error && <span className="text-stone-400"> ({run.error})</span>}
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
            <dd>
              +{run.itemsAdded} / ~{run.itemsUpdated}
            </dd>
          </div>
          <div>
            <dt className="text-stone-400">cost</dt>
            <dd>{run.costUsd != null ? `$${run.costUsd.toFixed(3)}` : "—"}</dd>
          </div>
          <div>
            <dt className="text-stone-400">warnings</dt>
            <dd className={warnings > 0 ? "text-amber-600" : undefined}>
              {warnings > 0 ? `⚠ ${warnings}` : "0"}
            </dd>
          </div>
        </dl>
      </div>

      <RunTranscript runId={run.id} initialEvents={events} live={live} />
    </div>
  );
}
