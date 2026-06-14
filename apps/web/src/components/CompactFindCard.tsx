import type { Find } from "@localfinds/db";

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Glanceable, read-only find block for the dashboard. Star/hide/thumbs live on
// the full feed (/feed) — this is just a window onto what's current.
export function CompactFindCard({ find }: { find: Find }) {
  const eventStart = formatDate(find.eventStart);

  return (
    <article className="rounded-lg border border-stone-200 bg-white p-3 shadow-sm">
      <h3 className="text-sm font-medium leading-snug">
        {find.url ? (
          <a
            href={find.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-700 hover:underline"
          >
            {find.title}
          </a>
        ) : (
          find.title
        )}
      </h3>
      {find.summary && (
        <p className="mt-1 line-clamp-2 text-xs text-stone-600">{find.summary}</p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-stone-500">
        {eventStart && (
          <span className="rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-800">
            {eventStart}
          </span>
        )}
        {find.tags.slice(0, 2).map((tag) => (
          <span key={tag} className="rounded bg-stone-100 px-1.5 py-0.5">
            {tag}
          </span>
        ))}
        <span className="ml-auto whitespace-nowrap">via {find.agent}</span>
      </div>
    </article>
  );
}
