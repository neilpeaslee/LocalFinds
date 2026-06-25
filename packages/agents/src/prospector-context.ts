// Run-grounded context for the interviewer (#3 "give it eyes"). read_current_config
// already shows the interviewer the region/towns/categories/current ICP; the one
// thing it can't see is what the prospector actually FOUND on prior runs. This
// module summarizes recent prospector runs + the lead tally into a compact block
// the runner injects into the live interview, so a refinement session is grounded
// in real results (the way an ad-hoc chat would pull up "run #37") instead of
// interviewing in a vacuum. On a true cold start (no runs yet) it yields "".

import { getFeed, getFeedPage, listRuns } from "@localfinds/db";

export interface ProspectorRunSummary {
  id: number;
  startedAt: string;
  status: string;
  itemsAdded: number;
  itemsUpdated: number;
  warnings: number;
}

// Pure (testable): render a compact "recent prospector activity" block from run
// rows + lead stats. Returns "" when there's nothing yet (cold start) so the
// caller can omit the section entirely.
export function formatProspectorActivity(
  runs: ProspectorRunSummary[],
  leadCount: number,
  recentLeadTitles: string[],
): string {
  if (runs.length === 0 && leadCount === 0) return "";

  const lines: string[] = [
    "## Recent prospector activity (context — you are REFINING existing targeting, not starting from a blank slate)",
    "The prospector has already run against the current config. Use this to sharpen what's there.",
  ];

  if (runs.length > 0) {
    lines.push("", "Recent runs:");
    for (const r of runs) {
      const date = r.startedAt.slice(0, 10);
      const warn =
        r.warnings > 0 ? `, ${r.warnings} warning${r.warnings === 1 ? "" : "s"}` : "";
      lines.push(
        `- #${r.id} ${date} — ${r.status}, +${r.itemsAdded} new / ~${r.itemsUpdated} updated${warn}`,
      );
    }
  }

  if (leadCount > 0) {
    lines.push("", `Leads flagged so far: ${leadCount}.`);
    if (recentLeadTitles.length > 0) {
      lines.push(`Recent examples: ${recentLeadTitles.join(", ")}.`);
    }
  }

  return lines.join("\n");
}

// db-backed wrapper (not unit-tested): pull the last few prospector runs and the
// lead tally, then format. Any failure (no DB yet on a fresh install, etc.)
// yields "" so a cold-start interview simply omits the section.
export function recentProspectorContext(): string {
  try {
    const runs = listRuns(50)
      .filter((r) => r.agent === "prospector")
      .slice(0, 3)
      .map((r) => ({
        id: r.id,
        startedAt: r.startedAt,
        status: r.status,
        itemsAdded: r.itemsAdded,
        itemsUpdated: r.itemsUpdated,
        warnings: r.warnings,
      }));
    const leadCount = getFeedPage({ type: "lead", pageSize: 1 }).total;
    const recentLeadTitles = getFeed({ type: "lead", limit: 6 }).map((f) => f.title);
    return formatProspectorActivity(runs, leadCount, recentLeadTitles);
  } catch {
    return "";
  }
}
