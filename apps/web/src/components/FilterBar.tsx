import Link from "next/link";

export interface FeedParams {
  view: string;
  days?: number;
  tag?: string;
}

function href(params: FeedParams): string {
  const qs = new URLSearchParams();
  if (params.view !== "default") qs.set("view", params.view);
  if (params.days) qs.set("days", String(params.days));
  if (params.tag) qs.set("tag", params.tag);
  const s = qs.toString();
  return s ? `/?${s}` : "/";
}

function Chip({
  active,
  to,
  label,
}: {
  active: boolean;
  to: FeedParams;
  label: string;
}) {
  return (
    <Link
      href={href(to)}
      className={`rounded-full px-2.5 py-0.5 text-xs ${
        active
          ? "bg-stone-800 text-white"
          : "bg-white text-stone-600 ring-1 ring-stone-200 hover:bg-stone-100"
      }`}
    >
      {label}
    </Link>
  );
}

const VIEWS = [
  ["default", "All current"],
  ["starred", "Starred"],
  ["hidden", "Hidden"],
  ["all", "Everything"],
] as const;

const WINDOWS = [
  [1, "24h"],
  [7, "7d"],
  [30, "30d"],
] as const;

export function FilterBar({
  current,
  tags,
}: {
  current: FeedParams;
  tags: string[];
}) {
  return (
    <div className="mb-4 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {VIEWS.map(([view, label]) => (
          <Chip
            key={view}
            active={current.view === view}
            to={{ ...current, view }}
            label={label}
          />
        ))}
        <span className="mx-1 text-stone-300">|</span>
        <Chip
          active={!current.days}
          to={{ ...current, days: undefined }}
          label="Any time"
        />
        {WINDOWS.map(([days, label]) => (
          <Chip
            key={days}
            active={current.days === days}
            to={{ ...current, days }}
            label={label}
          />
        ))}
      </div>
      {tags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {current.tag && (
            <Chip
              active
              to={{ ...current, tag: undefined }}
              label={`✕ ${current.tag}`}
            />
          )}
          {tags
            .filter((tag) => tag !== current.tag)
            .slice(0, 12)
            .map((tag) => (
              <Chip
                key={tag}
                active={false}
                to={{ ...current, tag }}
                label={tag}
              />
            ))}
        </div>
      )}
    </div>
  );
}
