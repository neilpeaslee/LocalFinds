import { and, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { db } from "./client";
import { findKey } from "./dedupe";
import { finds, sources } from "./schema";

export interface NewFindInput {
  title: string;
  url?: string | null;
  summary?: string | null;
  eventStart?: string | null;
  eventEnd?: string | null;
  expiresAt?: string | null;
  publishedAt?: string | null;
  tags?: string[];
  agent: string;
  sourceUrl?: string | null;
}

export interface SaveFindResult {
  outcome: "created" | "duplicate";
  id: number;
}

export function insertFind(input: NewFindInput): SaveFindResult {
  const urlHash = findKey({ url: input.url, title: input.title });
  const now = new Date().toISOString();

  let sourceId: number | undefined;
  if (input.sourceUrl) {
    sourceId = db()
      .select({ id: sources.id })
      .from(sources)
      .where(eq(sources.url, input.sourceUrl))
      .get()?.id;
  }

  const inserted = db()
    .insert(finds)
    .values({
      title: input.title,
      url: input.url ?? null,
      urlHash,
      summary: input.summary ?? null,
      eventStart: input.eventStart ?? null,
      eventEnd: input.eventEnd ?? null,
      expiresAt: input.expiresAt ?? null,
      publishedAt: input.publishedAt ?? null,
      discoveredAt: now,
      agent: input.agent,
      sourceId: sourceId ?? null,
      tags: input.tags ?? [],
    })
    .onConflictDoNothing({ target: finds.urlHash })
    .returning({ id: finds.id })
    .get();

  if (inserted) {
    if (sourceId !== undefined) {
      db()
        .update(sources)
        .set({
          findsCount: sql`${sources.findsCount} + 1`,
          lastFindAt: now,
        })
        .where(eq(sources.id, sourceId))
        .run();
    }
    return { outcome: "created", id: inserted.id };
  }

  const existing = db()
    .select({ id: finds.id })
    .from(finds)
    .where(eq(finds.urlHash, urlHash))
    .get();
  return { outcome: "duplicate", id: existing!.id };
}

export type FeedView = "default" | "starred" | "hidden" | "all";

export interface FeedFilters {
  view?: FeedView;
  days?: number;
  limit?: number;
}

export function getFeed(filters: FeedFilters = {}) {
  const conditions = [];
  const view = filters.view ?? "default";
  if (view === "default") conditions.push(ne(finds.status, "hidden"));
  if (view === "starred") conditions.push(eq(finds.status, "starred"));
  if (view === "hidden") conditions.push(eq(finds.status, "hidden"));
  if (filters.days) {
    const since = new Date(
      Date.now() - filters.days * 24 * 60 * 60 * 1000,
    ).toISOString();
    conditions.push(gte(finds.discoveredAt, since));
  }
  return db()
    .select()
    .from(finds)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(finds.discoveredAt))
    .limit(filters.limit ?? 200)
    .all();
}

// First render of a `new` find flips it to `shown`
export function markFindsShown(ids: number[]): void {
  if (ids.length === 0) return;
  db()
    .update(finds)
    .set({ status: "shown" })
    .where(and(inArray(finds.id, ids), eq(finds.status, "new")))
    .run();
}
