import {
  getFeedPage,
  listActiveTags,
  listFindTypes,
  markFindsShown,
} from "@localfinds/db";
import Link from "next/link";
import { bulkUpdateStatus, unhideAllAction } from "@/app/settings-actions";
import { FilterBar } from "@/components/FilterBar";
import { FindCard } from "@/components/FindCard";
import { SettingsPanel } from "@/components/SettingsPanel";
import { type FeedState, feedHref } from "@/lib/feed-url";
import { pageWindow } from "@/lib/pagination";
import { readSettings, resolveFeed } from "@/lib/settings";

export const dynamic = "force-dynamic";

function pill(active: boolean): string {
  return `rounded px-2 py-0.5 text-xs ${
    active
      ? "bg-stone-800 text-white"
      : "bg-stone-100 text-stone-600 hover:bg-stone-200"
  }`;
}

const bulkBtn =
  "rounded bg-stone-100 px-2 py-0.5 text-xs text-stone-600 hover:bg-stone-200";

export default async function FeedPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const settings = await readSettings();
  const r = resolveFeed(params, settings);

  const { rows, total, page, pageCount } = await getFeedPage({
    view: r.view,
    days: r.days,
    from: r.from,
    to: r.to,
    tag: r.tag,
    type: r.type,
    sort: r.sort,
    page: r.page,
    pageSize: r.pageSize === "all" ? undefined : r.pageSize,
  });
  await markFindsShown(rows.filter((f) => f.status === "new").map((f) => f.id));

  // Pager links carry the resolved filters; feedHref keeps them clean against
  // the cookie defaults and re-adds `page` (>1) explicitly.
  const feedState: FeedState = {
    view: r.view,
    days: r.days,
    from: r.from,
    to: r.to,
    tag: r.tag,
    type: r.type,
    pageSize: r.pageSize,
    density: r.density,
    sort: r.sort,
  };
  const pageHref = (p: number) => feedHref(feedState, settings.feed, p);

  const start = r.pageSize === "all" ? 0 : (page - 1) * r.pageSize;
  const ids = rows.map((f) => f.id).join(",");
  const tags = await listActiveTags();
  const types = await listFindTypes();

  return (
    <div className="flex flex-col gap-4">
      <SettingsPanel feed={settings.feed} />
      <FilterBar
        resolved={r}
        defaults={settings.feed}
        tags={tags}
        types={types}
      />

      {rows.length === 0 ? (
        <p className="py-12 text-center text-sm text-stone-500">
          Nothing here. Adjust the filters, or run{" "}
          <code className="rounded bg-stone-100 px-1">npm run agents:all</code>{" "}
          to gather fresh finds.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-stone-500">
              {r.pageSize === "all"
                ? `${total} ${total === 1 ? "find" : "finds"}`
                : `Showing ${start + 1}–${start + rows.length} of ${total} finds`}
            </p>
            <div className="flex items-center gap-1.5">
              {r.view === "hidden" ? (
                <form action={unhideAllAction}>
                  <button type="submit" className={bulkBtn}>
                    Unhide all
                  </button>
                </form>
              ) : (
                <>
                  <form action={bulkUpdateStatus}>
                    <input type="hidden" name="ids" value={ids} />
                    <input type="hidden" name="status" value="starred" />
                    <button type="submit" className={bulkBtn}>
                      Star page
                    </button>
                  </form>
                  <form action={bulkUpdateStatus}>
                    <input type="hidden" name="ids" value={ids} />
                    <input type="hidden" name="status" value="hidden" />
                    <button type="submit" className={bulkBtn}>
                      Hide page
                    </button>
                  </form>
                </>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-3">
            {rows.map((find) => (
              <FindCard key={find.id} find={find} density={r.density} />
            ))}
          </div>

          {r.pageSize !== "all" && pageCount > 1 && (
            <nav className="flex flex-wrap items-center justify-center gap-1.5 pt-2">
              {page > 1 ? (
                <Link
                  href={pageHref(page - 1)}
                  className={pill(false)}
                  aria-label="Previous page"
                >
                  ‹
                </Link>
              ) : (
                <span className={`${pill(false)} opacity-40`} aria-hidden="true">
                  ‹
                </span>
              )}
              {pageWindow(page, pageCount).map((p, i) =>
                p === "ellipsis" ? (
                  <span
                    key={`ellipsis-${i}`}
                    className="px-1 text-xs text-stone-400"
                  >
                    …
                  </span>
                ) : p === page ? (
                  <span key={p} className={pill(true)} aria-current="page">
                    {p}
                  </span>
                ) : (
                  <Link key={p} href={pageHref(p)} className={pill(false)}>
                    {p}
                  </Link>
                ),
              )}
              {page < pageCount ? (
                <Link
                  href={pageHref(page + 1)}
                  className={pill(false)}
                  aria-label="Next page"
                >
                  ›
                </Link>
              ) : (
                <span className={`${pill(false)} opacity-40`} aria-hidden="true">
                  ›
                </span>
              )}
            </nav>
          )}
        </>
      )}
    </div>
  );
}
