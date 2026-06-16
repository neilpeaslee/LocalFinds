import { getBusinessById, readAgentNote, readCategoryConfig } from "@localfinds/db";
import Link from "next/link";
import { notFound } from "next/navigation";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

export const dynamic = "force-dynamic";

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

export default async function BusinessDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: idParam } = await params;
  // Number() (not parseInt) so "1abc" becomes NaN and 404s instead of parsing to 1.
  const id = Number(idParam);
  if (!Number.isInteger(id) || id <= 0) notFound();

  const business = getBusinessById(id);
  if (!business) notFound();

  const cfg = readCategoryConfig();
  const tier = cfg.tierOf(business.kind);
  const isChain = Boolean(business.brand);
  const note = readAgentNote("cartographer", business.notesPath);

  return (
    <div className="flex flex-col gap-4">
      <Link href="/businesses" className="text-xs text-blue-700 hover:underline">
        ← Back to businesses
      </Link>

      <div className="flex flex-col gap-2 rounded-lg border border-stone-200 bg-white p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`rounded px-1.5 py-0.5 text-xs font-medium ${TIER_STYLE[tier] ?? ""}`}
            title="Search-priority tier"
          >
            T{tier}
          </span>
          <h2 className="text-base font-semibold">{business.name}</h2>
          {business.kind && (
            <span className="rounded bg-stone-100 px-1.5 py-0.5 text-xs text-stone-600">
              {business.kind}
            </span>
          )}
          {isChain && (
            <span
              className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800"
              title="National/regional chain (OSM brand)"
            >
              chain{business.brand ? `: ${business.brand}` : ""}
            </span>
          )}
          <span
            className={`rounded px-1.5 py-0.5 text-xs ${STATUS_STYLE[business.status] ?? ""}`}
          >
            {business.status}
          </span>
          {business.town && <span className="text-xs text-stone-500">{business.town}</span>}
        </div>

        {business.address && <div className="text-sm text-stone-600">{business.address}</div>}

        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-stone-500">
          {business.website && (
            <a
              href={business.website}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-700 hover:underline"
            >
              {business.website}
            </a>
          )}
          {business.phone && <span>{business.phone}</span>}
          <a
            href={`https://www.openstreetmap.org/${business.osmId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:underline"
            aria-label={`View ${business.name} on OpenStreetMap (opens in a new tab)`}
          >
            {business.osmId}
          </a>
        </div>

        {business.tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {business.tags.map((t) => (
              <Link
                key={t}
                href={`/businesses?tag=${encodeURIComponent(t)}`}
                className="rounded bg-stone-100 px-1.5 py-0.5 text-xs text-stone-600 hover:bg-stone-200"
              >
                {t}
              </Link>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-lg border border-stone-200 bg-white p-4">
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-stone-400">
          Cartographer note
        </h3>
        {note ? (
          <div className="prose prose-sm prose-stone max-w-none">
            <Markdown remarkPlugins={[remarkGfm]}>{note}</Markdown>
          </div>
        ) : (
          <p className="text-sm text-stone-500">No note yet.</p>
        )}
      </div>
    </div>
  );
}
