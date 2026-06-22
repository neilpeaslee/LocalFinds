import type { Find } from "@localfinds/db";
import Link from "next/link";
import { submitFeedback } from "@/app/actions";
import type { FeedDensity } from "@/lib/settings";

function ActionButton({
  findId,
  action,
  label,
  title,
  active = false,
}: {
  findId: number;
  action: string;
  label: string;
  title: string;
  active?: boolean;
}) {
  return (
    <form action={submitFeedback} className="inline">
      <input type="hidden" name="findId" value={findId} />
      <input type="hidden" name="action" value={action} />
      <button
        type="submit"
        title={title}
        className={`rounded px-1.5 py-0.5 text-sm hover:bg-stone-100 ${
          active ? "bg-amber-50" : ""
        }`}
      >
        {label}
      </button>
    </form>
  );
}

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

export function FindCard({
  find,
  density = "full",
}: {
  find: Find;
  density?: FeedDensity;
}) {
  const compact = density === "compact";
  const eventStart = formatDate(find.eventStart);
  const eventEnd = formatDate(find.eventEnd);
  const discovered = formatDate(find.discoveredAt);
  // Compact trades the summary and most tags for vertical density; the action
  // row stays (it's what distinguishes the feed from the read-only dashboard).
  const tags = compact ? find.tags.slice(0, 3) : find.tags;

  return (
    <article
      className={`rounded-lg border border-stone-200 bg-white shadow-sm ${
        compact ? "p-3" : "p-4"
      }`}
    >
      <h2 className={`font-medium leading-snug ${compact ? "text-sm" : ""}`}>
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
      {find.summary && !compact && (
        <p className="mt-1 text-sm text-stone-600">{find.summary}</p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-stone-500">
        {/* Type badge only for non-event finds; events stay visually identical. */}
        {find.type !== "event" && (
          <span className="rounded bg-emerald-100 px-1.5 py-0.5 font-medium capitalize text-emerald-800">
            {find.type}
            {find.score != null ? ` · fit ${Math.round(find.score * 100)}%` : ""}
          </span>
        )}
        {find.businessId != null && (
          <Link
            href={`/businesses/${find.businessId}`}
            className="rounded bg-stone-100 px-1.5 py-0.5 hover:bg-stone-200"
          >
            Business ↗
          </Link>
        )}
        {eventStart && (
          <span className="rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-800">
            {eventStart}
            {eventEnd && eventEnd !== eventStart ? ` – ${eventEnd}` : ""}
          </span>
        )}
        {tags.map((tag) => (
          <span key={tag} className="rounded bg-stone-100 px-1.5 py-0.5">
            {tag}
          </span>
        ))}
        <span className="ml-auto">
          via {find.agent}
          {discovered ? ` · ${discovered}` : ""}
        </span>
      </div>
      <div className="mt-2 flex items-center gap-1 border-t border-stone-100 pt-2">
        <ActionButton
          findId={find.id}
          action="thumbs_up"
          label="👍"
          title="More like this"
        />
        <ActionButton
          findId={find.id}
          action="thumbs_down"
          label="👎"
          title="Less like this"
        />
        {find.status === "starred" ? (
          <ActionButton
            findId={find.id}
            action="unstar"
            label="★ Starred"
            title="Remove star"
            active
          />
        ) : (
          <ActionButton
            findId={find.id}
            action="star"
            label="☆ Star"
            title="Star this find"
          />
        )}
        {find.status === "hidden" ? (
          <ActionButton
            findId={find.id}
            action="unhide"
            label="Unhide"
            title="Restore to feed"
          />
        ) : (
          <ActionButton
            findId={find.id}
            action="hide"
            label="Hide"
            title="Hide from feed"
          />
        )}
      </div>
    </article>
  );
}
