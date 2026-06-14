import type { Run } from "@localfinds/db";

export function duration(run: Run): string {
  if (!run.finishedAt) return "—";
  const ms = +new Date(run.finishedAt) - +new Date(run.startedAt);
  return `${Math.round(ms / 1000)}s`;
}
