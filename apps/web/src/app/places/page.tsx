import {
  type Place,
  type PlaceSort,
  type SortDir,
  listPlaceTowns,
  listPlacesRanked,
  parsePlaceSort,
  parseDir,
  readCategoryConfig,
} from "@localfinds/db";
import Link from "next/link";
import { PAGE_SIZES, pageWindow, parsePageSize } from "@/lib/pagination";
import { first, hrefWith } from "@/lib/url";

export const dynamic = "force-dynamic";

const STATUSES = ["active", "closed", "unknown"] as const;

const TIER_STYLE: Record<number, string> = {
  1: "bg-emerald-100 text-emerald-800",
  2: "bg-sky-100 text-sky-800",
  3: "bg-stone-100 text-stone-600",
  4: "bg-stone-100 text-stone-400",
};

const COLUMNS: { key: PlaceSort; label: string }[] = [
  { key: "tier", label: "Tier" },
  { key: "name", label: "Name" },
  { key: "kind", label: "Kind" },
  { key: "town", label: "Town" },
];

type Filters = {
  town?: string;
  status?: string;
  tag?: string;
  q?: string;
  tier4?: string;
  chains?: string;
  size?: string;
  page?: string;
  sort?: string;
  dir?: string;
};

function pill(active: boolean): string {
  return `rounded px-2 py-0.5 text-xs ${
    active ? "bg-stone-800 text-white" : "bg-stone-100 text-stone-600 hover:bg-stone-200"
  }`;
}

export default async function PlacesPage({
  searchParams,
}: {
  searchParams: Promise<Filters & Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const town = first(params.town) || undefined;
  const statusRaw = first(params.status);
  const status = STATUSES.includes(statusRaw as (typeof STATUSES)[number])
    ? (statusRaw as Place["status"])
    : undefined;
  const tag = first(params.tag) || undefined;
  const q = first(params.q) || undefined;
  const tier4 = first(params.tier4);
  const chains = first(params.chains);
  const size = parsePageSize(first(params.size));
  const pageReq = Math.max(1, Number.parseInt(first(params.page) ?? "", 10) || 1);
  const sort = parsePlaceSort(first(params.sort));
  const dir = parseDir(first(params.dir));
  // `size`/`sort`/`dir` ride along on filter/pager links; their defaults
  // (50 / ranking / asc) stay implicit to keep URLs clean. `page` is
  // deliberately NOT in `current`, so every filter, size, and sort link drops
  // it (resetting to page 1); only the numbered pager re-adds it.
  const current: Filters = {
    town,
    status,
    tag,
    q,
    tier4,
    chains,
    size: size === 50 ? undefined : String(size),
    sort: sort ?? undefined,
    dir: dir === "asc" ? undefined : dir,
  };

  const cfg = readCategoryConfig();
  const showTier4 = tier4 === "1" || !cfg.hideInDirectory.tier4;
  const showChains = chains === "1" || !cfg.hideInDirectory.chains;

  const { rows, total, matched, page, pageCount, tier4Count, chainCount } =
    await listPlacesRanked({
      town,
      status,
      tag,
      q,
      limit: 5000,
      includeTier4: showTier4,
      includeChains: showChains,
      page: pageReq,
      pageSize: size === "all" ? undefined : size,
      sort,
      dir,
    });
  const start = size === "all" ? 0 : (page - 1) * size;
  const towns = await listPlaceTowns();
  const hasFilters = Boolean(town || status || tag || q);

  const orderLabel = !sort
    ? "ranked by search priority"
    : sort === "tier"
      ? `sorted by tier (${dir === "asc" ? "Tier 1 → 4" : "Tier 4 → 1"})`
      : `sorted by ${sort} (${dir === "asc" ? "A–Z" : "Z–A"})`;

  if (total === 0 && !hasFilters) {
    return (
      <p className="py-12 text-center text-sm text-stone-500">
        No businesses yet. The cartographer agent populates this from
        OpenStreetMap on its first run (run{" "}
        <code className="rounded bg-stone-100 px-1">
          npm run agent -- cartographer
        </code>
        ).
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 rounded-lg border border-stone-200 bg-white p-3">
        <form action="/places" className="flex gap-2">
          {town && <input type="hidden" name="town" value={town} />}
          {status && <input type="hidden" name="status" value={status} />}
          {tag && <input type="hidden" name="tag" value={tag} />}
          {tier4 && <input type="hidden" name="tier4" value={tier4} />}
          {chains && <input type="hidden" name="chains" value={chains} />}
          {current.size && <input type="hidden" name="size" value={current.size} />}
          {current.sort && <input type="hidden" name="sort" value={current.sort} />}
          {current.dir && <input type="hidden" name="dir" value={current.dir} />}
          <input
            type="search"
            name="q"
            defaultValue={q ?? ""}
            placeholder="Search by name…"
            className="flex-1 rounded border border-stone-300 px-2 py-1 text-sm"
          />
          <button
            type="submit"
            className="rounded bg-stone-800 px-3 py-1 text-sm text-white"
          >
            Search
          </button>
        </form>

        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs font-medium text-stone-500">Status</span>
          <a href={hrefWith("/places", current, { status: undefined })} className={pill(!status)}>
            all
          </a>
          {STATUSES.map((s) => (
            <a key={s} href={hrefWith("/places", current, { status: s })} className={pill(status === s)}>
              {s}
            </a>
          ))}
        </div>

        {towns.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-xs font-medium text-stone-500">Town</span>
            <a href={hrefWith("/places", current, { town: undefined })} className={pill(!town)}>
              all
            </a>
            {towns.map((t) => (
              <a
                key={t.town}
                href={hrefWith("/places", current, { town: t.town })}
                className={pill(town === t.town)}
              >
                {t.town} <span className="opacity-60">{t.n}</span>
              </a>
            ))}
          </div>
        )}

        {(chainCount > 0 || tier4Count > 0) && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-xs font-medium text-stone-500">Show</span>
            {chainCount > 0 && (
              <a
                href={hrefWith("/places", current, { chains: showChains ? undefined : "1" })}
                className={pill(showChains)}
              >
                chains ({chainCount})
              </a>
            )}
            {tier4Count > 0 && (
              <a
                href={hrefWith("/places", current, { tier4: showTier4 ? undefined : "1" })}
                className={pill(showTier4)}
              >
                excluded categories ({tier4Count})
              </a>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs font-medium text-stone-500">Per page</span>
          {PAGE_SIZES.map((s) => (
            <a
              key={s}
              href={hrefWith("/places", current, { size: s === 50 ? undefined : String(s) })}
              className={pill(size === s)}
            >
              {s === "all" ? "All" : s}
            </a>
          ))}
        </div>

        {tag && (
          <div className="text-xs text-stone-500">
            Tag: <span className="font-medium">{tag}</span>{" "}
            <a href={hrefWith("/places", current, { tag: undefined })} className="text-blue-700 hover:underline">
              clear
            </a>
          </div>
        )}
      </div>

      <p className="text-xs text-stone-500">
        {size === "all" || matched === 0
          ? `${matched} ${matched === 1 ? "business" : "businesses"}`
          : `Showing ${start + 1}–${start + rows.length} of ${matched} businesses`}
        {hasFilters ? " matching filters" : ""}, {orderLabel}
      </p>

      {matched === 0 ? (
        <p className="py-8 text-center text-sm text-stone-500">
          No businesses match these filters.
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-stone-200 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-stone-200 text-xs text-stone-500">
                {COLUMNS.map((col) => {
                  const isActive = sort === col.key;
                  const nextDir: SortDir = isActive && dir === "asc" ? "desc" : "asc";
                  return (
                    <th
                      key={col.key}
                      scope="col"
                      aria-sort={
                        isActive ? (dir === "asc" ? "ascending" : "descending") : "none"
                      }
                      className="px-3 py-2 text-left font-medium"
                    >
                      <a
                        href={hrefWith("/places", current, {
                          sort: col.key,
                          dir: nextDir === "asc" ? undefined : nextDir,
                        })}
                        className="inline-flex items-center gap-1 hover:text-stone-900"
                      >
                        {col.label}
                        {isActive && (
                          <span aria-hidden="true">{dir === "asc" ? "▲" : "▼"}</span>
                        )}
                      </a>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map(({ place: b, tier, isChain }) => (
                <tr key={b.osmId} className="border-b border-stone-100 last:border-0">
                  <td className="px-3 py-2">
                    <span
                      className={`rounded px-1.5 py-0.5 text-xs font-medium ${TIER_STYLE[tier] ?? ""}`}
                      title="Search-priority tier"
                    >
                      T{tier}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <Link
                      href={`/places/${b.osmId}`}
                      className="font-medium text-stone-900 hover:underline"
                    >
                      {b.name}
                    </Link>
                    {isChain && (
                      <span
                        className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800"
                        title="National/regional chain (OSM brand)"
                      >
                        chain{b.brand ? `: ${b.brand}` : ""}
                      </span>
                    )}
                    {b.website && (
                      <a
                        href={b.website}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ml-1.5 text-xs text-blue-700 hover:underline"
                        title={b.website}
                        aria-label={`Visit ${b.name} website (opens in a new tab)`}
                      >
                        ↗
                      </a>
                    )}
                  </td>
                  <td className="px-3 py-2 text-stone-600">{b.kind ?? "—"}</td>
                  <td className="px-3 py-2 text-stone-500">{b.town ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {size !== "all" && pageCount > 1 && (
        <nav className="flex flex-wrap items-center justify-center gap-1.5 pt-2">
          {page > 1 ? (
            <a
              href={hrefWith("/places", current, { page: String(page - 1) })}
              className={pill(false)}
              aria-label="Previous page"
            >
              ‹
            </a>
          ) : (
            <span className={`${pill(false)} opacity-40`} aria-hidden="true">
              ‹
            </span>
          )}
          {pageWindow(page, pageCount).map((p, i) =>
            p === "ellipsis" ? (
              <span key={`ellipsis-${i}`} className="px-1 text-xs text-stone-400">
                …
              </span>
            ) : p === page ? (
              <span key={p} className={pill(true)} aria-current="page">
                {p}
              </span>
            ) : (
              <a key={p} href={hrefWith("/places", current, { page: String(p) })} className={pill(false)}>
                {p}
              </a>
            ),
          )}
          {page < pageCount ? (
            <a
              href={hrefWith("/places", current, { page: String(page + 1) })}
              className={pill(false)}
              aria-label="Next page"
            >
              ›
            </a>
          ) : (
            <span className={`${pill(false)} opacity-40`} aria-hidden="true">
              ›
            </span>
          )}
        </nav>
      )}
    </div>
  );
}
