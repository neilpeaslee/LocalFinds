import {
  getFeed,
  listActiveTags,
  markFindsShown,
  type FeedView,
} from "@localfinds/db";
import { FindCard } from "@/components/FindCard";
import { FilterBar } from "@/components/FilterBar";

export const dynamic = "force-dynamic";

const VIEWS: FeedView[] = ["default", "starred", "hidden", "all"];

export default async function FeedPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; days?: string; tag?: string }>;
}) {
  const params = await searchParams;
  const view = VIEWS.includes(params.view as FeedView)
    ? (params.view as FeedView)
    : "default";
  const days = params.days ? Number(params.days) || undefined : undefined;
  const tag = params.tag || undefined;

  const items = getFeed({ view, days, tag });
  markFindsShown(items.filter((f) => f.status === "new").map((f) => f.id));

  return (
    <div>
      <FilterBar current={{ view, days, tag }} tags={listActiveTags()} />
      {items.length === 0 ? (
        <p className="py-12 text-center text-sm text-stone-500">
          Nothing here. Adjust the filters, or run{" "}
          <code className="rounded bg-stone-100 px-1">npm run agents:all</code>{" "}
          to gather fresh finds.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {items.map((find) => (
            <FindCard key={find.id} find={find} />
          ))}
        </div>
      )}
    </div>
  );
}
