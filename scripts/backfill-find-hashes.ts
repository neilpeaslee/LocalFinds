// One-time (and re-runnable) migration: recompute url_hash for every url-bearing
// find now that findKey() keys on url + title instead of url alone. Without this,
// a find stored under the old url-only hash would no longer match when re-found,
// silently creating a duplicate row. Url-less finds are untouched (their
// title-only hash is unchanged). Safe to re-run: it only writes rows whose hash
// actually differs, and skips any recompute that would collide with another row.
// Run from the repo root: npx tsx scripts/backfill-find-hashes.ts
import { db, finds, findKey } from "@localfinds/db";
import { eq, isNotNull } from "drizzle-orm";

const rows = db()
  .select({ id: finds.id, title: finds.title, url: finds.url, urlHash: finds.urlHash })
  .from(finds)
  .where(isNotNull(finds.url))
  .all();

let updated = 0;
let unchanged = 0;
let skipped = 0;
const seen = new Map<string, number>(); // new hash -> find id, to catch collisions

for (const row of rows) {
  const next = findKey({ url: row.url, title: row.title });
  if (next === row.urlHash) {
    unchanged++;
    continue;
  }
  const clash = seen.get(next);
  if (clash !== undefined) {
    console.warn(
      `! find ${row.id} would collide with ${clash} on the new hash — skipping`,
    );
    skipped++;
    continue;
  }
  seen.set(next, row.id);
  db().update(finds).set({ urlHash: next }).where(eq(finds.id, row.id)).run();
  updated++;
}

console.log(
  `Backfilled find hashes: ${updated} updated, ${unchanged} already current, ${skipped} skipped (collision).`,
);
