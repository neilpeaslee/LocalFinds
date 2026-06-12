import { sql } from "drizzle-orm";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Dates are ISO 8601 strings. Exact, structured facts only — fuzzy judgment
// (relevance, source quality, soft dedupe) lives in the agents' markdown.

export const sources = sqliteTable("sources", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  url: text("url").notNull().unique(),
  name: text("name"),
  notesPath: text("notes_path"),
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
  // sha256 of normalized url, or of normalized title when url-less
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

export const runs = sqliteTable("runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  agent: text("agent").notNull(),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
  status: text("status", { enum: ["running", "success", "error"] })
    .notNull()
    .default("running"),
  itemsAdded: integer("items_added").notNull().default(0),
  itemsUpdated: integer("items_updated").notNull().default(0),
  numTurns: integer("num_turns"),
  costUsd: real("cost_usd"),
  usageJson: text("usage_json"),
  sessionId: text("session_id"),
  error: text("error"),
});

export type Find = typeof finds.$inferSelect;
export type Source = typeof sources.$inferSelect;
export type Feedback = typeof feedback.$inferSelect;
export type Run = typeof runs.$inferSelect;
