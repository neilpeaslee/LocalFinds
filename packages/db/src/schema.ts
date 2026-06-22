import { sql } from "drizzle-orm";
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

// Dates are ISO 8601 strings. Exact, structured facts only — fuzzy judgment
// (relevance, source quality, soft dedupe) lives in the agents' markdown.

export const sources = sqliteTable("sources", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  url: text("url").notNull().unique(),
  name: text("name"),
  notesPath: text("notes_path"),
  icalUrl: text("ical_url"),
  status: text("status", { enum: ["active", "paused", "dead"] })
    .notNull()
    .default("active"),
  qualityScore: real("quality_score"),
  findsCount: integer("finds_count").notNull().default(0),
  lastFindAt: text("last_find_at"),
  lastCheckedAt: text("last_checked_at"),
  addedBy: text("added_by").notNull(),
  createdAt: text("created_at").notNull(),
});

export const finds = sqliteTable("finds", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  url: text("url"),
  // sha256 of normalized url + title, or of normalized title when url-less
  urlHash: text("url_hash").notNull().unique(),
  summary: text("summary"),
  eventStart: text("event_start"),
  eventEnd: text("event_end"),
  expiresAt: text("expires_at"),
  publishedAt: text("published_at"),
  discoveredAt: text("discovered_at").notNull(),
  status: text("status", { enum: ["new", "shown", "hidden", "starred"] })
    .notNull()
    .default("new"),
  agent: text("agent").notNull(),
  sourceId: integer("source_id").references(() => sources.id),
  tags: text("tags", { mode: "json" })
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'`),
  score: real("score"),
  // Free-text discriminator (cf. businesses.kind): "event" (default), "lead",
  // and later "resource-search"/"news"/etc. Taxonomy is applied at render time.
  type: text("type").notNull().default("event"),
  // Nullable FK linking a lead to its OSM business record. Forward reference —
  // businesses is declared after finds; the thunk resolves it.
  businessId: integer("business_id").references(() => businesses.id),
});

export const feedback = sqliteTable("feedback", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  findId: integer("find_id")
    .notNull()
    .references(() => finds.id),
  action: text("action", {
    enum: ["thumbs_up", "thumbs_down", "star", "unstar", "hide", "unhide"],
  }).notNull(),
  note: text("note"),
  createdAt: text("created_at").notNull(),
});

// A business in the region, mirrored from OpenStreetMap by the cartographer.
// Exact facts only — deduped by the OSM stable id. The business↔source link is
// deliberately left fuzzy (a plain website string), for the agents to resolve.
export const businesses = sqliteTable("businesses", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // "node/123" | "way/456" | "relation/789"
  osmId: text("osm_id").notNull().unique(),
  name: text("name").notNull(),
  // Verbatim OSM primary tag, e.g. "amenity=cafe". Not a controlled taxonomy.
  kind: text("kind"),
  tags: text("tags", { mode: "json" })
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'`),
  address: text("address"),
  town: text("town"),
  lat: real("lat"),
  lng: real("lng"),
  website: text("website"),
  phone: text("phone"),
  // OSM brand tag — present means a national/regional chain (forced to lowest priority).
  brand: text("brand"),
  status: text("status", { enum: ["active", "closed", "unknown"] })
    .notNull()
    .default("active"),
  notesPath: text("notes_path"),
  addedBy: text("added_by").notNull(),
  discoveredAt: text("discovered_at").notNull(),
  // Last run Overpass still returned this osmId — cursor for the "maybe closed" sweep.
  lastSeenAt: text("last_seen_at").notNull(),
  // Non-null = this row is a hidden duplicate of that canonical osm_id, set by
  // the cartographer's post-run dedupe sweep. Null = canonical or unique.
  duplicateOf: text("duplicate_of"),
}, (t) => [
  // The directory and the list_businesses tool filter by town/status and order
  // by (town, name); index those so neither does a full scan + filesort.
  index("businesses_town_name_idx").on(t.town, t.name),
  index("businesses_status_idx").on(t.status),
]);

export const runs = sqliteTable("runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  agent: text("agent").notNull(),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
  // "capped" = the run stopped on its budget guardrail (error_max_budget_usd)
  // after completing and persisting its work — a normal, non-error outcome.
  status: text("status", { enum: ["running", "success", "capped", "error"] })
    .notNull()
    .default("running"),
  itemsAdded: integer("items_added").notNull().default(0),
  itemsUpdated: integer("items_updated").notNull().default(0),
  // Non-fatal tool failures during the run (e.g. an aborted Overpass query) —
  // counted from the run log so a "success" run still surfaces its hiccups.
  warnings: integer("warnings").notNull().default(0),
  numTurns: integer("num_turns"),
  costUsd: real("cost_usd"),
  usageJson: text("usage_json"),
  sessionId: text("session_id"),
  error: text("error"),
});

// One row per WebFetch call (scout, for now). klass is the durable signal;
// status is best-effort (often 200 by assumption on success). via is reserved
// for a future controlled fetch tool so it can be added without a migration.
export const fetches = sqliteTable(
  "fetches",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: integer("run_id").references(() => runs.id),
    agent: text("agent").notNull(),
    host: text("host").notNull(),
    url: text("url").notNull(),
    method: text("method").notNull().default("GET"),
    status: integer("status"),
    klass: text("klass", {
      enum: ["ok", "blocked", "truncated", "error"],
    }).notNull(),
    via: text("via").notNull().default("webfetch"),
    ts: text("ts").notNull(),
  },
  (t) => [index("fetches_host_idx").on(t.host), index("fetches_run_idx").on(t.runId)],
);

export type FetchClass = (typeof fetches.$inferInsert)["klass"];

export type Find = typeof finds.$inferSelect;
export type Source = typeof sources.$inferSelect;
export type Business = typeof businesses.$inferSelect;
export type Feedback = typeof feedback.$inferSelect;
export type Run = typeof runs.$inferSelect;
export type Fetch = typeof fetches.$inferSelect;
