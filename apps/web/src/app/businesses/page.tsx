import {
  agentWorkspaceDir,
  listBusinesses,
  listBusinessTowns,
  readCategoryConfig,
  type Business,
} from "@localfinds/db";
import fs from "node:fs";
import path from "node:path";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

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
};

function readBusinessNote(notesPath: string | null): string | null {
  if (!notesPath) return null;
  const workspace = agentWorkspaceDir("cartographer");
  const resolved = path.resolve(workspace, notesPath);
  if (!resolved.startsWith(workspace + path.sep)) return null;
  try {
    return fs.readFileSync(resolved, "utf8");
  } catch {
    return null;
  }
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
  searchParams: Promise<Filters>;
}) {
  const params = await searchParams;
  const town = params.town || undefined;
  const status = STATUSES.includes(params.status as (typeof STATUSES)[number])
    ? (params.status as Business["status"])
    : undefined;
  const tag = params.tag || undefined;
  const q = params.q || undefined;
  const current: Filters = {
    town,
    status,
    tag,
    q,
    tier4: params.tier4,
    chains: params.chains,
  };

  const cfg = readCategoryConfig();
  const showTier4 = params.tier4 === "1" || !cfg.hideInDirectory.tier4;
  const showChains = params.chains === "1" || !cfg.hideInDirectory.chains;

  const all = listBusinesses({ town, status, tag, q, limit: 5000 }).map((b) => ({
    b,
    tier: cfg.tierOf(b.kind),
    isChain: Boolean(b.brand),
  }));
  const towns = listBusinessTowns();
  const hasFilters = Boolean(town || status || tag || q);

  if (towns.length === 0 && !hasFilters) {
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

  const hiddenTier4 = all.filter((x) => x.tier === 4).length;
  const hiddenChains = all.filter((x) => x.isChain).length;

  const visible = all
    .filter((x) => (showTier4 || x.tier !== 4) && (showChains || !x.isChain))
    .sort(
      (a, z) =>
        Number(a.isChain) - Number(z.isChain) ||
        a.tier - z.tier ||
        a.b.name.localeCompare(z.b.name),
    );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 rounded-lg border border-stone-200 bg-white p-3">
        <form action="/businesses" className="flex gap-2">
          {town && <input type="hidden" name="town" value={town} />}
          {status && <input type="hidden" name="status" value={status} />}
          {tag && <input type="hidden" name="tag" value={tag} />}
          {params.tier4 && <input type="hidden" name="tier4" value={params.tier4} />}
          {params.chains && <input type="hidden" name="chains" value={params.chains} />}
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

        {(hiddenChains > 0 || hiddenTier4 > 0) && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-xs font-medium text-stone-500">Show</span>
            {hiddenChains > 0 && (
              <a
                href={hrefWith(current, { chains: showChains ? undefined : "1" })}
                className={pill(showChains)}
              >
                chains ({hiddenChains})
              </a>
            )}
            {hiddenTier4 > 0 && (
              <a
                href={hrefWith(current, { tier4: showTier4 ? undefined : "1" })}
                className={pill(showTier4)}
              >
                excluded categories ({hiddenTier4})
              </a>
            )}
          </div>
        )}

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
        {visible.length} {visible.length === 1 ? "business" : "businesses"}
        {hasFilters ? " matching filters" : ""}, ranked by search priority
      </p>

      {visible.length === 0 ? (
        <p className="py-8 text-center text-sm text-stone-500">
          No businesses match these filters.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {visible.map(({ b, tier, isChain }) => {
            const note = readBusinessNote(b.notesPath);
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
                    {b.lat != null && b.lng != null && (
                      <a
                        href={`https://www.openstreetmap.org/${b.osmId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:underline"
                      >
                        {b.osmId}
                      </a>
                    )}
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
    </div>
  );
}
