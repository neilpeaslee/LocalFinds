import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dbPath } from "./paths";

/**
 * Merge a local snapshot's discovery data into the prod DB. Local is
 * authoritative for sources/finds/businesses/runs/fetches; prod is authoritative
 * for user activity — feedback rows and finds.status are never written here.
 */
export function syncMerge(incomingPath: string, prodPath: string = dbPath()): void {
  const db = new Database(prodPath);
  db.pragma("foreign_keys = ON");
  db.prepare("ATTACH DATABASE ? AS src").run(incomingPath);

  const tx = db.transaction(() => {
    // sources — upsert by url
    db.exec(`
      INSERT INTO main.sources
        (url, name, notes_path, ical_url, status, quality_score, finds_count, last_find_at, last_checked_at, added_by, created_at)
      SELECT
        url, name, notes_path, ical_url, status, quality_score, finds_count, last_find_at, last_checked_at, added_by, created_at
      FROM src.sources WHERE true
      ON CONFLICT(url) DO UPDATE SET
        name=excluded.name, notes_path=excluded.notes_path, ical_url=excluded.ical_url,
        status=excluded.status, quality_score=excluded.quality_score, finds_count=excluded.finds_count,
        last_find_at=excluded.last_find_at, last_checked_at=excluded.last_checked_at, added_by=excluded.added_by
    `);

    // businesses — upsert by osm_id
    db.exec(`
      INSERT INTO main.businesses
        (osm_id, name, kind, tags, address, town, lat, lng, website, phone, brand, status, notes_path, added_by, discovered_at, last_seen_at, duplicate_of)
      SELECT
        osm_id, name, kind, tags, address, town, lat, lng, website, phone, brand, status, notes_path, added_by, discovered_at, last_seen_at, duplicate_of
      FROM src.businesses WHERE true
      ON CONFLICT(osm_id) DO UPDATE SET
        name=excluded.name, kind=excluded.kind, tags=excluded.tags, address=excluded.address,
        town=excluded.town, lat=excluded.lat, lng=excluded.lng, website=excluded.website, phone=excluded.phone,
        brand=excluded.brand, status=excluded.status, notes_path=excluded.notes_path, added_by=excluded.added_by,
        last_seen_at=excluded.last_seen_at, duplicate_of=excluded.duplicate_of
    `);

    // finds — upsert by url_hash; NEVER write status; remap source_id by url.
    // status is omitted on insert (schema default 'new') and from the update set.
    db.exec(`
      INSERT INTO main.finds
        (title, url, url_hash, summary, event_start, event_end, expires_at, published_at, discovered_at, agent, source_id, tags, score)
      SELECT
        s.title, s.url, s.url_hash, s.summary, s.event_start, s.event_end, s.expires_at, s.published_at, s.discovered_at, s.agent,
        (SELECT m.id FROM main.sources m JOIN src.sources ss ON ss.url = m.url WHERE ss.id = s.source_id),
        s.tags, s.score
      FROM src.finds s WHERE true
      ON CONFLICT(url_hash) DO UPDATE SET
        title=excluded.title, url=excluded.url, summary=excluded.summary,
        event_start=excluded.event_start, event_end=excluded.event_end, expires_at=excluded.expires_at,
        published_at=excluded.published_at, agent=excluded.agent, source_id=excluded.source_id,
        tags=excluded.tags, score=excluded.score
    `);

    // runs — preserve id (local owns the id space); prod never writes runs, so
    // overwriting mutable fields from local is always correct.
    db.exec(`
      INSERT INTO main.runs
        (id, agent, started_at, finished_at, status, items_added, items_updated, warnings, num_turns, cost_usd, usage_json, session_id, error)
      SELECT
        id, agent, started_at, finished_at, status, items_added, items_updated, warnings, num_turns, cost_usd, usage_json, session_id, error
      FROM src.runs WHERE true
      ON CONFLICT(id) DO UPDATE SET
        agent=excluded.agent, started_at=excluded.started_at, finished_at=excluded.finished_at, status=excluded.status,
        items_added=excluded.items_added, items_updated=excluded.items_updated, warnings=excluded.warnings,
        num_turns=excluded.num_turns, cost_usd=excluded.cost_usd, usage_json=excluded.usage_json,
        session_id=excluded.session_id, error=excluded.error
    `);

    // fetches — preserve id + run_id; immutable, so skip rows already present.
    db.exec(`
      INSERT INTO main.fetches
        (id, run_id, agent, host, url, method, status, klass, via, ts)
      SELECT
        id, run_id, agent, host, url, method, status, klass, via, ts
      FROM src.fetches WHERE true
      ON CONFLICT(id) DO NOTHING
    `);
  });
  try {
    tx();
  } finally {
    db.exec("DETACH DATABASE src");
    db.close();
  }
}

// CLI entry: `tsx src/sync-merge.ts <incoming.db> [prod.db]`
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const incoming = process.argv[2];
  if (!incoming) {
    console.error("usage: tsx src/sync-merge.ts <incoming-snapshot.db> [prod-db]");
    process.exit(1);
  }
  if (!fs.existsSync(incoming)) {
    console.error(`sync-merge: incoming snapshot not found: ${incoming}`);
    process.exit(1);
  }
  syncMerge(incoming, process.argv[3]);
  console.log("content merge complete");
}
