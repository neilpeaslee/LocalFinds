import type { Find } from "@localfinds/db";

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function FindCard({ find }: { find: Find }) {
  const eventStart = formatDate(find.eventStart);
  const eventEnd = formatDate(find.eventEnd);
  const discovered = formatDate(find.discoveredAt);

  return (
    <article className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
      <h2 className="font-medium leading-snug">
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
      </h2>
      {find.summary && (
        <p className="mt-1 text-sm text-stone-600">{find.summary}</p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-stone-500">
        {eventStart && (
          <span className="rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-800">
            {eventStart}
            {eventEnd && eventEnd !== eventStart ? ` – ${eventEnd}` : ""}
          </span>
        )}
        {find.tags.map((tag) => (
          <span key={tag} className="rounded bg-stone-100 px-1.5 py-0.5">
            {tag}
          </span>
        ))}
        <span className="ml-auto">
          via {find.agent}
          {discovered ? ` · ${discovered}` : ""}
        </span>
      </div>
    </article>
  );
}
