import { listSources } from "@localfinds/db";
import Link from "next/link";
import {
  type SortDir,
  type SourceSort,
  SOURCE_STATUSES,
  filterSources,
  parseDir,
  parseSort,
  parseStatus,
  sortSources,
  summarizeSources,
} from "@/lib/sources";

export const dynamic = "force-dynamic";

const STATUS_STYLE: Record<string, string> = {
  active: "bg-green-100 text-green-800",
  paused: "bg-stone-200 text-stone-600",
  dead: "bg-red-100 text-red-800",
};

// Column order matches the spec: Name · Status · Finds · Quality · Last checked.
// Status is intentionally not sortable (use the filter pills instead).
const COLUMNS: {
  key: SourceSort | "status";
  label: string;
  sortable: boolean;
  align: string;
}[] = [
  { key: "name", label: "Name", sortable: true, align: "text-left" },
  { key: "status", label: "Status", sortable: false, align: "text-left" },
  { key: "finds", label: "Finds", sortable: true, align: "text-right" },
  { key: "quality", label: "Quality", sortable: true, align: "text-right" },
  { key: "checked", label: "Last checked", sortable: true, align: "text-right" },
];

type Query = { q?: string; status?: string; sort?: string; dir?: string };

// Next.js delivers string[] for a repeated query key; take the first.
function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function hrefWith(current: Query, patch: Query): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...current, ...patch })) {
    if (v) params.set(k, v);
  }
  const qs = params.toString();
  return qs ? `/sources?${qs}` : "/sources";
}

function pill(active: boolean): string {
  return `rounded px-2 py-0.5 text-xs ${
    active ? "bg-stone-800 text-white" : "bg-stone-100 text-stone-600 hover:bg-stone-200"
  }`;
}

function shortDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString() : "—";
}

export default async function SourcesPage({
  searchParams,
}: {
  searchParams: Promise<Query & Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const q = first(params.q)?.trim() || undefined;
  const status = parseStatus(first(params.status));
  const sort = parseSort(first(params.sort));
  const dir = parseDir(first(params.dir));

  const all = await listSources();

  if (all.length === 0) {
    return (
      <p className="py-12 text-center text-sm text-stone-500">
        No sources registered yet. The source-keeper agent populates this on
        its first run (seed it via data/config/region.md).
      </p>
    );
  }

  const summary = summarizeSources(all);
  const rows = sortSources(filterSources(all, { q, status }), sort, dir);

  // `sort`/`dir` ride along on filter links; their defaults (name/asc) stay
  // implicit to keep URLs clean.
  const current: Query = {
    q,
    status,
    sort: sort === "name" ? undefined : sort,
    dir: dir === "asc" ? undefined : dir,
  };
  const hasFilters = Boolean(q || status);

  const summaryParts = [
    `${summary.total} ${summary.total === 1 ? "source" : "sources"}`,
    ...SOURCE_STATUSES.filter((s) => summary.byStatus[s] > 0).map(
      (s) => `${summary.byStatus[s]} ${s}`,
    ),
    `${summary.totalFinds} ${summary.totalFinds === 1 ? "find" : "finds"}`,
  ];
  if (summary.avgQuality != null) {
    summaryParts.push(`avg quality ${summary.avgQuality.toFixed(1)}`);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 rounded-lg border border-stone-200 bg-white p-3">
        <p className="text-xs text-stone-500">{summaryParts.join(" · ")}</p>

        <form action="/sources" className="flex gap-2">
          {status && <input type="hidden" name="status" value={status} />}
          {current.sort && <input type="hidden" name="sort" value={current.sort} />}
          {current.dir && <input type="hidden" name="dir" value={current.dir} />}
          <input
            type="search"
            name="q"
            defaultValue={q ?? ""}
            placeholder="Search by name or URL…"
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
          {SOURCE_STATUSES.map((s) => (
            <a key={s} href={hrefWith(current, { status: s })} className={pill(status === s)}>
              {s}
            </a>
          ))}
        </div>
      </div>

      <p className="text-xs text-stone-500">
        {hasFilters
          ? `${rows.length} of ${all.length} matching filters`
          : `${all.length} ${all.length === 1 ? "source" : "sources"}`}
      </p>

      {rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-stone-500">
          No sources match these filters.
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-stone-200 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-stone-200 text-xs text-stone-500">
                {COLUMNS.map((col) => {
                  if (!col.sortable) {
                    return (
                      <th
                        key={col.key}
                        scope="col"
                        className={`px-3 py-2 font-medium ${col.align}`}
                      >
                        {col.label}
                      </th>
                    );
                  }
                  const sortKey = col.key as SourceSort;
                  const isActive = sort === sortKey;
                  const nextDir: SortDir = isActive && dir === "asc" ? "desc" : "asc";
                  return (
                    <th
                      key={col.key}
                      scope="col"
                      aria-sort={
                        isActive
                          ? dir === "asc"
                            ? "ascending"
                            : "descending"
                          : "none"
                      }
                      className={`px-3 py-2 font-medium ${col.align}`}
                    >
                      <a
                        href={hrefWith(current, {
                          // Drop the defaults (name/asc) so the link stays clean.
                          sort: sortKey === "name" ? undefined : sortKey,
                          dir: nextDir === "asc" ? undefined : nextDir,
                        })}
                        className="inline-flex items-center gap-1 hover:text-stone-900"
                      >
                        {col.label}
                        {isActive && <span aria-hidden>{dir === "asc" ? "▲" : "▼"}</span>}
                      </a>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id} className="border-b border-stone-100 last:border-0">
                  <td className="px-3 py-2">
                    <Link
                      href={`/sources/${s.id}`}
                      className="font-medium text-stone-900 hover:underline"
                    >
                      {s.name ?? new URL(s.url).hostname}
                    </Link>
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ml-1.5 text-xs text-blue-700 hover:underline"
                      title={s.url}
                      aria-label={`Visit ${s.name ?? s.url} (opens in a new tab)`}
                    >
                      ↗
                    </a>
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`rounded px-1.5 py-0.5 text-xs ${STATUS_STYLE[s.status] ?? ""}`}
                    >
                      {s.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{s.findsCount}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {s.qualityScore != null ? s.qualityScore.toFixed(1) : "—"}
                  </td>
                  <td className="px-3 py-2 text-right text-stone-500">
                    {shortDate(s.lastCheckedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
