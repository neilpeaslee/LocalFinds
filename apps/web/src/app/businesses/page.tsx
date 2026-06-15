import {
  type Business,
  listBusinessTowns,
  listBusinessesRanked,
  readAgentNote,
  readCategoryConfig,
} from "@localfinds/db";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PAGE_SIZES, pageWindow, parsePageSize } from "@/lib/pagination";

export const dynamic = "force-dynamic";

const STATUSES = ["active", "closed", "unknown"] as const;

const STATUS_STYLE: Record<string, string> = {
  active: "bg-green-100 text-green-800",
  closed: "bg-red-100 text-red-800",
  unknown: "bg-stone-200 text-stone-600",
};

const TIER_STYLE: Record<number, string> = {
  1: "bg-emerald-100 text-emerald-800",
  2: "bg-sky-100 text-sky-800",
  3: "bg-stone-100 text-stone-600",
  4: "bg-stone-100 text-stone-400",
};

type Filters = {
  town?: string;
  status?: string;
  tag?: string;
  q?: string;
  tier4?: string;
  chains?: string;
  size?: string;
  page?: string;
};

// Next.js delivers string[] for a repeated query key (?q=a&q=b); take the first.
function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function hrefWith(current: Filters, patch: Filters): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...current, ...patch })) {
    if (v) params.set(k, v);
  }
  const qs = params.toString();
  return qs ? `/businesses?${qs}` : "/businesses";
}

function pill(active: boolean): string {
  return `rounded px-2 py-0.5 text-xs ${
    active ? "bg-stone-800 text-white" : "bg-stone-100 text-stone-600 hover:bg-stone-200"
  }`;
}

export default async function BusinessesPage({
  searchParams,
}: {
  searchParams: Promise<Filters & Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const town = first(params.town) || undefined;
  const statusRaw = first(params.status);
  const status = STATUSES.includes(statusRaw as (typeof STATUSES)[number])
    ? (statusRaw as Business["status"])
    : undefined;
  const tag = first(params.tag) || undefined;
  const q = first(params.q) || undefined;
  const tier4 = first(params.tier4);
  const chains = first(params.chains);
  const size = parsePageSize(first(params.size));
  const pageReq = Math.max(1, Number.parseInt(first(params.page) ?? "", 10) || 1);
  // `size` rides along on filter/pager links; the default (50) stays implicit to
  // keep URLs clean. `page` is deliberately NOT in `current`, so every filter and
  // size link drops it (resetting to page 1); only the numbered pager re-adds it.
  const current: Filters = {
    town,
    status,
    tag,
    q,
    tier4,
    chains,
    size: size === 50 ? undefined : String(size),
  };

  const cfg = readCategoryConfig();
  const showTier4 = tier4 === "1" || !cfg.hideInDirectory.tier4;
  const showChains = chains === "1" || !cfg.hideInDirectory.chains;

  // The query layer owns tier/chain ranking, visibility, sorting, and counts.
  const { rows, total, matched, page, pageCount, tier4Count, chainCount } =
    listBusinessesRanked({
      town,
      status,
      tag,
      q,
      limit: 5000,
      includeTier4: showTier4,
      includeChains: showChains,
      page: pageReq,
      pageSize: size === "all" ? undefined : size,
    });
  const start = size === "all" ? 0 : (page - 1) * size;
  const towns = listBusinessTowns();
  const hasFilters = Boolean(town || status || tag || q);

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
        <form action="/businesses" className="flex gap-2">
          {town && <input type="hidden" name="town" value={town} />}
          {status && <input type="hidden" name="status" value={status} />}
          {tag && <input type="hidden" name="tag" value={tag} />}
          {tier4 && <input type="hidden" name="tier4" value={tier4} />}
          {chains && <input type="hidden" name="chains" value={chains} />}
          {current.size && <input type="hidden" name="size" value={current.size} />}
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
          <a href={hrefWith(current, { status: undefined })} className={pill(!status)}>
            all
          </a>
          {STATUSES.map((s) => (
            <a key={s} href={hrefWith(current, { status: s })} className={pill(status === s)}>
              {s}
            </a>
          ))}
        </div>

        {towns.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-xs font-medium text-stone-500">Town</span>
            <a href={hrefWith(current, { town: undefined })} className={pill(!town)}>
              all
            </a>
            {towns.map((t) => (
              <a
                key={t.town}
                href={hrefWith(current, { town: t.town })}
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
                href={hrefWith(current, { chains: showChains ? undefined : "1" })}
                className={pill(showChains)}
              >
                chains ({chainCount})
              </a>
            )}
            {tier4Count > 0 && (
              <a
                href={hrefWith(current, { tier4: showTier4 ? undefined : "1" })}
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
              href={hrefWith(current, { size: s === 50 ? undefined : String(s) })}
              className={pill(size === s)}
            >
              {s === "all" ? "All" : s}
            </a>
          ))}
        </div>

        {tag && (
          <div className="text-xs text-stone-500">
            Tag: <span className="font-medium">{tag}</span>{" "}
            <a href={hrefWith(current, { tag: undefined })} className="text-blue-700 hover:underline">
              clear
            </a>
          </div>
        )}
      </div>

      <p className="text-xs text-stone-500">
        {size === "all" || matched === 0
          ? `${matched} ${matched === 1 ? "business" : "businesses"}`
          : `Showing ${start + 1}–${start + rows.length} of ${matched} businesses`}
        {hasFilters ? " matching filters" : ""}, ranked by search priority
      </p>

      {matched === 0 ? (
        <p className="py-8 text-center text-sm text-stone-500">
          No businesses match these filters.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map(({ business: b, tier, isChain }) => {
            const note = readAgentNote("cartographer", b.notesPath);
            return (
              <details
                key={b.id}
                className="rounded-lg border border-stone-200 bg-white p-3"
              >
                <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-sm">
                  <span
                    className={`rounded px-1.5 py-0.5 text-xs font-medium ${TIER_STYLE[tier] ?? ""}`}
                    title="Search-priority tier"
                  >
                    T{tier}
                  </span>
                  <span className="font-medium">{b.name}</span>
                  {b.kind && (
                    <span className="rounded bg-stone-100 px-1.5 py-0.5 text-xs text-stone-600">
                      {b.kind}
                    </span>
                  )}
                  {isChain && (
                    <span
                      className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800"
                      title="National/regional chain (OSM brand)"
                    >
                      chain{b.brand ? `: ${b.brand}` : ""}
                    </span>
                  )}
                  <span
                    className={`rounded px-1.5 py-0.5 text-xs ${STATUS_STYLE[b.status] ?? ""}`}
                  >
                    {b.status}
                  </span>
                  <span className="ml-auto text-xs text-stone-500">{b.town ?? ""}</span>
                </summary>
                <div className="mt-3 flex flex-col gap-2 border-t border-stone-100 pt-3 text-sm">
                  {b.address && <div className="text-stone-600">{b.address}</div>}
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-stone-500">
                    {b.website && (
                      <a
                        href={b.website}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-700 hover:underline"
                      >
                        {b.website}
                      </a>
                    )}
                    {b.phone && <span>{b.phone}</span>}
                    <a
                      href={`https://www.openstreetmap.org/${b.osmId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:underline"
                    >
                      {b.osmId}
                    </a>
                  </div>
                  {b.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {b.tags.map((t) => (
                        <a
                          key={t}
                          href={hrefWith(current, { tag: t })}
                          className="rounded bg-stone-100 px-1.5 py-0.5 text-xs text-stone-600 hover:bg-stone-200"
                        >
                          {t}
                        </a>
                      ))}
                    </div>
                  )}
                  {note && (
                    <div className="prose prose-sm prose-stone mt-1 max-w-none">
                      <Markdown remarkPlugins={[remarkGfm]}>{note}</Markdown>
                    </div>
                  )}
                </div>
              </details>
            );
          })}
        </div>
      )}

      {size !== "all" && pageCount > 1 && (
        <nav className="flex flex-wrap items-center justify-center gap-1.5 pt-2">
          {page > 1 ? (
            <a
              href={hrefWith(current, { page: String(page - 1) })}
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
              <a key={p} href={hrefWith(current, { page: String(p) })} className={pill(false)}>
                {p}
              </a>
            ),
          )}
          {page < pageCount ? (
            <a
              href={hrefWith(current, { page: String(page + 1) })}
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
