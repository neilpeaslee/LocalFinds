import { getFeed, markFindsShown } from "@localfinds/db";
import { FindCard } from "@/components/FindCard";

export const dynamic = "force-dynamic";

export default function FeedPage() {
  const items = getFeed();
  markFindsShown(items.filter((f) => f.status === "new").map((f) => f.id));

  if (items.length === 0) {
    return (
      <p className="py-12 text-center text-sm text-stone-500">
        No finds yet. Run <code className="rounded bg-stone-100 px-1">npm run db:seed</code>{" "}
        or a gathering agent to populate the feed.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {items.map((find) => (
        <FindCard key={find.id} find={find} />
      ))}
    </div>
  );
}
