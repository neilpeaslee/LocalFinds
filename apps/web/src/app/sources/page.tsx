import { agentWorkspaceDir, listSources } from "@localfinds/db";
import fs from "node:fs";
import path from "node:path";
import Markdown from "react-markdown";

export const dynamic = "force-dynamic";

function readSiteNote(notesPath: string | null): string | null {
  if (!notesPath) return null;
  const workspace = agentWorkspaceDir("source-keeper");
  const resolved = path.resolve(workspace, notesPath);
  if (!resolved.startsWith(workspace + path.sep)) return null;
  try {
    return fs.readFileSync(resolved, "utf8");
  } catch {
    return null;
  }
}

const STATUS_STYLE: Record<string, string> = {
  active: "bg-green-100 text-green-800",
  paused: "bg-stone-200 text-stone-600",
  dead: "bg-red-100 text-red-800",
};

export default function SourcesPage() {
  const sources = listSources();

  if (sources.length === 0) {
    return (
      <p className="py-12 text-center text-sm text-stone-500">
        No sources registered yet. The source-keeper agent populates this on
        its first run (seed it via data/config/region.md).
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {sources.map((source) => {
        const note = readSiteNote(source.notesPath);
        return (
          <details
            key={source.id}
            className="rounded-lg border border-stone-200 bg-white p-3"
          >
            <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">
                {source.name ?? new URL(source.url).hostname}
              </span>
              <a
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
                className="truncate text-xs text-blue-700 hover:underline"
              >
                {source.url}
              </a>
              <span
                className={`rounded px-1.5 py-0.5 text-xs ${STATUS_STYLE[source.status] ?? ""}`}
              >
                {source.status}
              </span>
              <span className="ml-auto text-xs text-stone-500">
                {source.findsCount} finds
                {source.qualityScore != null &&
                  ` · quality ${source.qualityScore.toFixed(1)}`}
                {source.lastCheckedAt &&
                  ` · checked ${new Date(source.lastCheckedAt).toLocaleDateString()}`}
              </span>
            </summary>
            <div className="prose prose-sm prose-stone mt-3 max-w-none border-t border-stone-100 pt-3">
              {note ? (
                <Markdown>{note}</Markdown>
              ) : (
                <p className="text-stone-500">No site note yet.</p>
              )}
            </div>
          </details>
        );
      })}
    </div>
  );
}
