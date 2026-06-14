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
            <dd
              className={
                run.status === "success"
                  ? "text-green-700"
                  : run.status === "running"
                    ? "text-amber-700"
                    : "text-red-700"
              }
            >
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
            <dd>
              +{run.itemsAdded} / ~{run.itemsUpdated}
            </dd>
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
