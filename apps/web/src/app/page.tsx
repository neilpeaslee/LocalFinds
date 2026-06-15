import {
  countBusinesses,
  getFeed,
  listMapPins,
  readMapCategories,
  readRegionConfig,
  readTownBoundaries,
  readTownsConfig,
} from "@localfinds/db";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CompactFindCard } from "@/components/CompactFindCard";
import RegionMapClient from "@/components/RegionMapClient";

export const dynamic = "force-dynamic";

const COMPACT_FINDS = 6;

// Show the human-facing coverage prose only: drop the YAML frontmatter and the
// internal "Seed sources" section that region.md keeps for the agents.
function coverageProse(raw: string): string {
  const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, "");
  const seedIdx = body.search(/^##\s+Seed sources/im);
  return (seedIdx >= 0 ? body.slice(0, seedIdx) : body).trim();
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-base font-semibold text-stone-900">{value}</span>
      <span>{label}</span>
    </div>
  );
}

export default function DashboardPage() {
  const region = readRegionConfig();
  const { towns } = readTownsConfig();
  const boundaries = readTownBoundaries();

  const pins = listMapPins();
  const mapCfg = readMapCategories();
  const mapThemes = [
    ...mapCfg.themes.map((t) => ({ key: t.key, label: t.label, color: t.color })),
    { key: mapCfg.otherKey, label: mapCfg.otherLabel, color: mapCfg.otherColor },
  ];
  const businessCount = countBusinesses();

  const finds = getFeed({ view: "default" });
  const recent = finds.slice(0, COMPACT_FINDS);

  return (
    <div className="flex flex-col gap-6">
      <RegionMapClient towns={towns} boundaries={boundaries} businesses={pins} themes={mapThemes} />

      <section>
        <h1 className="text-xl font-semibold tracking-tight">
          {region?.name ?? "Your region"}
        </h1>
        {region && coverageProse(region.raw) && (
          <div className="prose prose-sm prose-stone mt-2 max-w-none">
            <Markdown remarkPlugins={[remarkGfm]}>
              {coverageProse(region.raw)}
            </Markdown>
          </div>
        )}
        <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm text-stone-600">
          <Stat label="towns covered" value={towns.length} />
          <Stat label="businesses catalogued" value={businessCount} />
          <Stat label="current finds" value={finds.length} />
        </dl>
      </section>

      <section>
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-lg font-semibold tracking-tight">Current finds</h2>
          <a href="/feed" className="text-sm text-blue-700 hover:underline">
            View all →
          </a>
        </div>
        {recent.length === 0 ? (
          <p className="py-8 text-center text-sm text-stone-500">
            No current finds. Run{" "}
            <code className="rounded bg-stone-100 px-1">npm run agents:all</code>{" "}
            to gather fresh finds.
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {recent.map((find) => (
              <CompactFindCard key={find.id} find={find} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
