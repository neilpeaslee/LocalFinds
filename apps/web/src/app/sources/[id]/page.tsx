import { getSourceById, listFindsBySource, readAgentNote } from "@localfinds/db";
import Link from "next/link";
import { notFound } from "next/navigation";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

export const dynamic = "force-dynamic";

const STATUS_STYLE: Record<string, string> = {
  active: "bg-green-100 text-green-800",
  paused: "bg-stone-200 text-stone-600",
  dead: "bg-red-100 text-red-800",
};

const FIND_STATUS_STYLE: Record<string, string> = {
  new: "bg-blue-100 text-blue-800",
  shown: "bg-stone-100 text-stone-600",
  hidden: "bg-stone-200 text-stone-500",
  starred: "bg-amber-100 text-amber-800",
};

function shortDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString() : "—";
}

export default async function SourceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: idParam } = await params;
  // Number() (not parseInt) so "1abc" becomes NaN and 404s instead of parsing to 1.
  const id = Number(idParam);
  if (!Number.isInteger(id) || id <= 0) notFound();

  const source = getSourceById(id);
  if (!source) notFound();

  const note = readAgentNote("source-keeper", source.notesPath);
  const finds = listFindsBySource(source.id, 10);

  const meta = [
    source.qualityScore != null ? `quality ${source.qualityScore.toFixed(1)}` : null,
    `${source.findsCount} ${source.findsCount === 1 ? "find" : "finds"}`,
    source.lastCheckedAt ? `checked ${shortDate(source.lastCheckedAt)}` : null,
    `added by ${source.addedBy}`,
    `created ${shortDate(source.createdAt)}`,
  ].filter(Boolean);

  return (
    <div className="flex flex-col gap-4">
      <Link href="/sources" className="text-xs text-blue-700 hover:underline">
        ← Back to sources
      </Link>

      <div className="flex flex-col gap-2 rounded-lg border border-stone-200 bg-white p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-semibold">
            {source.name ?? new URL(source.url).hostname}
          </h2>
          <a
            href={source.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-blue-700 hover:underline"
          >
            {source.url} <span aria-hidden>↗</span>
          </a>
          <span
            className={`rounded px-1.5 py-0.5 text-xs ${STATUS_STYLE[source.status] ?? ""}`}
          >
            {source.status}
          </span>
        </div>
        <p className="text-xs text-stone-500">{meta.join(" · ")}</p>
      </div>

      <div className="rounded-lg border border-stone-200 bg-white p-4">
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-stone-400">
          Site note
        </h3>
        {note ? (
          <div className="prose prose-sm prose-stone max-w-none">
            <Markdown remarkPlugins={[remarkGfm]}>{note}</Markdown>
          </div>
        ) : (
          <p className="text-sm text-stone-500">No site note yet.</p>
        )}
      </div>

      {finds.length > 0 && (
        <div className="rounded-lg border border-stone-200 bg-white p-4">
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-stone-400">
            Recent finds from this source
          </h3>
          <ul className="flex flex-col divide-y divide-stone-100">
            {finds.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                {f.url ? (
                  <a
                    href={f.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-stone-900 hover:underline"
                  >
                    {f.title}
                  </a>
                ) : (
                  <span className="font-medium text-stone-900">{f.title}</span>
                )}
                <span
                  className={`rounded px-1.5 py-0.5 text-xs ${FIND_STATUS_STYLE[f.status] ?? ""}`}
                >
                  {f.status}
                </span>
                <span className="ml-auto text-xs text-stone-500">
                  {shortDate(f.discoveredAt)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
