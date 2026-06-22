import Link from "next/link";
import { DateRangePicker } from "@/components/DateRangePicker";
import { type FeedDefaults, type FeedState, feedHref } from "@/lib/feed-url";
import { PAGE_SIZES } from "@/lib/pagination";
import type { ResolvedFeed } from "@/lib/settings";

function Chip({
  active,
  href,
  label,
}: {
  active: boolean;
  href: string;
  label: string;
}) {
  return (
    <Link
      href={href}
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

const SORTS = [
  ["newest", "Newest"],
  ["oldest", "Oldest"],
  ["soonest", "Soonest"],
] as const;

const DENSITIES = [
  ["full", "Full"],
  ["compact", "Compact"],
] as const;

export function FilterBar({
  resolved,
  defaults,
  tags,
  types,
}: {
  resolved: ResolvedFeed;
  defaults: FeedDefaults;
  tags: string[];
  types: string[];
}) {
  const base: FeedState = {
    view: resolved.view,
    days: resolved.days,
    from: resolved.from,
    to: resolved.to,
    tag: resolved.tag,
    type: resolved.type,
    pageSize: resolved.pageSize,
    density: resolved.density,
    sort: resolved.sort,
  };
  const rangeActive = Boolean(resolved.from || resolved.to);
  // Each chip is the resolved state with one field changed; feedHref then emits
  // only what differs from the cookie defaults.
  const href = (patch: Partial<FeedState>) => feedHref({ ...base, ...patch }, defaults);

  return (
    <div className="mb-4 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {VIEWS.map(([view, label]) => (
          <Chip
            key={view}
            active={resolved.view === view}
            href={href({ view })}
            label={label}
          />
        ))}
        <span className="mx-1 text-stone-300">|</span>
        <Chip
          active={!resolved.days && !rangeActive}
          href={href({ days: undefined, from: undefined, to: undefined })}
          label="Any time"
        />
        {WINDOWS.map(([days, label]) => (
          <Chip
            key={days}
            active={resolved.days === days}
            href={href({ days, from: undefined, to: undefined })}
            label={label}
          />
        ))}
      </div>

      <DateRangePicker
        state={base}
        defaults={defaults}
        from={resolved.from}
        to={resolved.to}
      />

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-xs font-medium text-stone-500">Per page</span>
        {PAGE_SIZES.map((s) => (
          <Chip
            key={s}
            active={resolved.pageSize === s}
            href={href({ pageSize: s })}
            label={s === "all" ? "All" : String(s)}
          />
        ))}
        <span className="mx-1 text-stone-300">|</span>
        <span className="mr-1 text-xs font-medium text-stone-500">Sort</span>
        {SORTS.map(([sort, label]) => (
          <Chip
            key={sort}
            active={resolved.sort === sort}
            href={href({ sort })}
            label={label}
          />
        ))}
        <span className="mx-1 text-stone-300">|</span>
        <span className="mr-1 text-xs font-medium text-stone-500">Cards</span>
        {DENSITIES.map(([density, label]) => (
          <Chip
            key={density}
            active={resolved.density === density}
            href={href({ density })}
            label={label}
          />
        ))}
      </div>

      {types.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs font-medium text-stone-500">Type</span>
          <Chip active={!resolved.type} href={href({ type: undefined })} label="All" />
          {types.map((type) => (
            <Chip
              key={type}
              active={resolved.type === type}
              href={href({ type })}
              label={type.charAt(0).toUpperCase() + type.slice(1)}
            />
          ))}
        </div>
      )}

      {tags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {resolved.tag && (
            <Chip active href={href({ tag: undefined })} label={`✕ ${resolved.tag}`} />
          )}
          {tags
            .filter((tag) => tag !== resolved.tag)
            .slice(0, 12)
            .map((tag) => (
              <Chip key={tag} active={false} href={href({ tag })} label={tag} />
            ))}
        </div>
      )}
    </div>
  );
}
