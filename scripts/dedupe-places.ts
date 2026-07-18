// One-time (and re-runnable) cleanup: collapse duplicate OSM elements already
// in the directory. Resolves the same data dir as the app/agents via @localfinds/db.
// Run from the repo root: npx tsx scripts/dedupe-places.ts
import { dedupePlaces } from "@localfinds/db";

const summary = dedupePlaces();
console.log(
  `Deduped businesses: marked ${summary.marked} duplicate(s) across ${summary.groups} group(s).`,
);
