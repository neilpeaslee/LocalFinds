import {
  agentWorkspaceDir,
  costLastNDays,
  listRuns,
  type Run,
} from "@localfinds/db";
import fs from "node:fs";
import path from "node:path";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

export const dynamic = "force-dynamic";

const AGENTS = ["scout", "source-keeper", "curator"];

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

function duration(run: Run): string {
  if (!run.finishedAt) return "—";
  const ms = +new Date(run.finishedAt) - +new Date(run.startedAt);
  return `${Math.round(ms / 1000)}s`;
}

function RunRow({ run }: { run: Run }) {
  return (
    <tr className="border-t border-stone-100 text-xs">
      <td className="py-1 pr-3 whitespace-nowrap">
        {new Date(run.startedAt).toLocaleString()}
      </td>
      <td className="pr-3">
        <span
          className={
            run.status === "success"
              ? "text-green-700"
              : run.status === "running"
                ? "text-amber-700"
                : "text-red-700"
          }
        >
          {run.status}
        </span>
        {run.error && <span className="text-stone-400"> ({run.error})</span>}
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

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-stone-600">
        Agent spend, last 30 days:{" "}
        <span className="font-semibold">${cost30.toFixed(2)}</span>
      </p>
      {AGENTS.map((agent) => {
        const profile = readProfile(agent);
        const runs = allRuns.filter((r) => r.agent === agent).slice(0, 10);
        return (
          <section
            key={agent}
            className="rounded-lg border border-stone-200 bg-white p-4"
          >
            <h2 className="font-semibold">{agent}</h2>
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
                    <RunRow key={run.id} run={run} />
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
