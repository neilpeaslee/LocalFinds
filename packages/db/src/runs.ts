import type { Run } from "./schema";

// The agent roster, in the order the full sequence ("all") runs them. Mirrors
// cli.ts's rosterOrder; the /agents page renders one section per name.
export const ROSTER = [
  "scout",
  "source-keeper",
  "prospector",
  "curator",
] as const;
export type AgentName = (typeof ROSTER)[number];
export type RunTarget = AgentName | "all";

// Valid targets a run can be triggered for — the allowlist the web action
// validates form input against before spawning the CLI.
export const RUN_TARGETS: readonly RunTarget[] = [...ROSTER, "all"];

// A `running` row older than this is treated as a crashed run: it no longer
// blocks new triggers and the UI flags it as likely-crashed. Agent runs are
// capped (maxTurns + maxBudgetUsd) and finish in minutes, so 20m is generous.
export const RUN_STALE_MS = 20 * 60 * 1000;

export function resolveTarget(input: string): RunTarget | null {
  return (RUN_TARGETS as readonly string[]).includes(input)
    ? (input as RunTarget)
    : null;
}

export function isRunStale(
  run: Run,
  now: number,
  staleMs = RUN_STALE_MS,
): boolean {
  return run.status === "running" && now - Date.parse(run.startedAt) >= staleMs;
}

// True when a run is live (status `running` and started within the staleness
// window) — the concurrency guard refuses new triggers while this holds.
export function runInProgress(
  runs: Run[],
  now: number,
  staleMs = RUN_STALE_MS,
): boolean {
  return runs.some(
    (run) =>
      run.status === "running" && now - Date.parse(run.startedAt) < staleMs,
  );
}
