import {
  ROSTER,
  agentWorkspaceDir,
  costLastNDays,
  isRunStale,
  listRuns,
  runInProgress,
  type Run,
} from "@localfinds/db";
import fs from "node:fs";
import path from "node:path";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import Link from "next/link";
import { RunTranscript } from "@/components/RunTranscript";
import { triggerRun } from "./actions";
import { duration } from "@/lib/run-utils";

export const dynamic = "force-dynamic";

function readProfile(agent: string): string | null {
  try {
    return fs.readFileSync(
      path.join(agentWorkspaceDir(agent), "profile.md"),
      "utf8",
    );
  } catch {
    return null;
  }
}

function RunButton({ target, label, disabled }: {
  target: string;
  label: string;
  disabled: boolean;
}) {
  return (
    <form action={triggerRun.bind(null, target)}>
      <button
        type="submit"
        disabled={disabled}
        className="rounded border border-stone-300 px-2 py-1 text-xs font-medium text-stone-700 hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {label}
      </button>
    </form>
  );
}

function RunRow({ run, now }: { run: Run; now: number }) {
  const stale = isRunStale(run, now);
  return (
    <tr className="border-t border-stone-100 text-xs">
      <td className="py-1 pr-3 whitespace-nowrap">
        <Link
          href={`/agents/runs/${run.id}`}
          className="text-stone-700 hover:underline"
        >
          {new Date(run.startedAt).toLocaleString()}
        </Link>
      </td>
      <td className="pr-3">
        {stale ? (
          <span className="text-red-700">running — likely crashed</span>
        ) : (
          <span
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
            {run.status}
          </span>
        )}
        {run.error && <span className="text-stone-400"> ({run.error})</span>}
        {run.warnings > 0 && (
          <span
            className="ml-1 text-amber-600"
            title={`${run.warnings} non-fatal tool failure(s) during this run`}
          >
            ⚠ {run.warnings}
          </span>
        )}
      </td>
      <td className="pr-3 text-right">{duration(run)}</td>
      <td className="pr-3 text-right">{run.numTurns ?? "—"}</td>
      <td className="pr-3 text-right">
        +{run.itemsAdded} / ~{run.itemsUpdated}
      </td>
      <td className="text-right">
        {run.costUsd != null ? `$${run.costUsd.toFixed(3)}` : "—"}
      </td>
    </tr>
  );
}

export default function AgentsPage() {
  const allRuns = listRuns(200);
  const cost30 = costLastNDays(30);
  const now = Date.now();
  const inProgress = runInProgress(allRuns, now);
  const activeRun = allRuns.find(
    (r) => r.status === "running" && !isRunStale(r, now),
  );

  return (
    <div className="flex flex-col gap-6">
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
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-stone-600">
          Agent spend, last 30 days:{" "}
          <span className="font-semibold">${cost30.toFixed(2)}</span>
        </p>
        <div className="flex items-center gap-3">
          {inProgress && (
            <span className="text-xs text-amber-700">run in progress…</span>
          )}
          <RunButton target="all" label="Run all" disabled={inProgress} />
        </div>
      </div>
      {ROSTER.map((agent) => {
        const profile = readProfile(agent);
        const runs = allRuns.filter((r) => r.agent === agent).slice(0, 10);
        return (
          <section
            key={agent}
            className="rounded-lg border border-stone-200 bg-white p-4"
          >
            <div className="flex items-center justify-between gap-4">
              <h2 className="font-semibold">{agent}</h2>
              <RunButton target={agent} label="Run" disabled={inProgress} />
            </div>
            <details className="mt-2">
              <summary className="cursor-pointer text-sm text-stone-600">
                Interest profile (data/agents/{agent}/profile.md — hand-editable)
              </summary>
              <div className="prose prose-sm prose-stone mt-2 max-w-none rounded bg-stone-50 p-3">
                {profile ? (
                  <Markdown remarkPlugins={[remarkGfm]}>{profile}</Markdown>
                ) : (
                  <p className="text-stone-500">
                    No profile yet — created on the agent&apos;s first run.
                  </p>
                )}
              </div>
            </details>
            {runs.length > 0 ? (
              <table className="mt-3 w-full text-left">
                <thead>
                  <tr className="text-xs text-stone-500">
                    <th className="pr-3 font-normal">started</th>
                    <th className="pr-3 font-normal">status</th>
                    <th className="pr-3 text-right font-normal">time</th>
                    <th className="pr-3 text-right font-normal">turns</th>
                    <th className="pr-3 text-right font-normal">added/upd</th>
                    <th className="text-right font-normal">cost</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => (
                    <RunRow key={run.id} run={run} now={now} />
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="mt-3 text-sm text-stone-500">No runs yet.</p>
            )}
          </section>
        );
      })}
    </div>
  );
}
