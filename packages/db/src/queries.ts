import { and, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { db } from "./client";
import { findKey } from "./dedupe";
import { feedback, finds, runs, sources } from "./schema";

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
  tag?: string;
  limit?: number;
}

// Items stay visible through their expiry date (date-prefix comparison works
// for both date and datetime ISO strings).
function notExpired() {
  const today = new Date().toISOString().slice(0, 10);
  return sql`(${finds.expiresAt} is null or ${finds.expiresAt} >= ${today})`;
}

export function getFeed(filters: FeedFilters = {}) {
  const conditions = [];
  const view = filters.view ?? "default";
  if (view === "default") {
    conditions.push(ne(finds.status, "hidden"), notExpired());
  }
  if (view === "starred") {
    conditions.push(eq(finds.status, "starred"), notExpired());
  }
  if (view === "hidden") conditions.push(eq(finds.status, "hidden"));
  if (filters.days) {
    const since = new Date(
      Date.now() - filters.days * 24 * 60 * 60 * 1000,
    ).toISOString();
    conditions.push(gte(finds.discoveredAt, since));
  }
  if (filters.tag) {
    // tags is a JSON string array — exact-element match on the serialized form
    conditions.push(
      sql`exists (select 1 from json_each(${finds.tags}) where json_each.value = ${filters.tag})`,
    );
  }
  return db()
    .select()
    .from(finds)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(finds.discoveredAt))
    .limit(filters.limit ?? 200)
    .all();
}

// Distinct tags among currently feed-visible items, for the filter bar.
export function listActiveTags(limit = 30): string[] {
  const rows = db().all<{ tag: string; n: number }>(
    sql`select json_each.value as tag, count(*) as n
        from ${finds}, json_each(${finds.tags})
        where ${finds.status} != 'hidden' and (${finds.expiresAt} is null or ${finds.expiresAt} >= ${new Date().toISOString().slice(0, 10)})
        group by tag order by n desc limit ${limit}`,
  );
  return rows.map((r) => r.tag);
}

export function costLastNDays(days = 30): number {
  const since = new Date(
    Date.now() - days * 24 * 60 * 60 * 1000,
  ).toISOString();
  const row = db().get<{ total: number | null }>(
    sql`select sum(${runs.costUsd}) as total from ${runs} where ${runs.startedAt} >= ${since}`,
  );
  return row?.total ?? 0;
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

export type FindStatus = "new" | "shown" | "hidden" | "starred";

export function listRecentFinds(
  opts: { days?: number; status?: FindStatus; limit?: number } = {},
) {
  const since = new Date(
    Date.now() - (opts.days ?? 7) * 24 * 60 * 60 * 1000,
  ).toISOString();
  const conditions = [gte(finds.discoveredAt, since)];
  if (opts.status) conditions.push(eq(finds.status, opts.status));
  return db()
    .select()
    .from(finds)
    .where(and(...conditions))
    .orderBy(desc(finds.discoveredAt))
    .limit(opts.limit ?? 100)
    .all();
}

export function updateFindStatus(id: number, status: FindStatus): boolean {
  return db().update(finds).set({ status }).where(eq(finds.id, id)).run()
    .changes > 0;
}

export function setFindExpiry(id: number, expiresAt: string): boolean {
  return db().update(finds).set({ expiresAt }).where(eq(finds.id, id)).run()
    .changes > 0;
}

export function recordFeedback(
  findId: number,
  action: typeof feedback.$inferInsert.action,
  note?: string,
): void {
  db()
    .insert(feedback)
    .values({ findId, action, note, createdAt: new Date().toISOString() })
    .run();
}

function lastSuccessfulRunStart(agent: string): string | null {
  return (
    db()
      .select({ startedAt: runs.startedAt })
      .from(runs)
      .where(and(eq(runs.agent, agent), eq(runs.status, "success")))
      .orderBy(desc(runs.startedAt))
      .limit(1)
      .get()?.startedAt ?? null
  );
}

// An agent's "unread feedback" is everything newer than its last successful run.
export function readFeedbackForAgent(agent: string, limit = 200) {
  const cutoff = lastSuccessfulRunStart(agent);
  return db()
    .select({
      id: feedback.id,
      action: feedback.action,
      note: feedback.note,
      createdAt: feedback.createdAt,
      findId: feedback.findId,
      findTitle: finds.title,
      findUrl: finds.url,
      findTags: finds.tags,
      foundBy: finds.agent,
    })
    .from(feedback)
    .innerJoin(finds, eq(feedback.findId, finds.id))
    .where(cutoff ? gte(feedback.createdAt, cutoff) : undefined)
    .orderBy(desc(feedback.createdAt))
    .limit(limit)
    .all();
}

export function listSources() {
  return db().select().from(sources).orderBy(sources.url).all();
}

export interface UpsertSourceInput {
  url: string;
  name?: string;
  status?: "active" | "paused" | "dead";
  qualityScore?: number;
  notesPath?: string;
  addedBy: string;
}

export function upsertSource(input: UpsertSourceInput): { id: number } {
  const now = new Date().toISOString();
  const set: Record<string, unknown> = { lastCheckedAt: now };
  if (input.name !== undefined) set.name = input.name;
  if (input.status !== undefined) set.status = input.status;
  if (input.qualityScore !== undefined) set.qualityScore = input.qualityScore;
  if (input.notesPath !== undefined) set.notesPath = input.notesPath;
  return db()
    .insert(sources)
    .values({
      url: input.url,
      name: input.name,
      status: input.status ?? "active",
      qualityScore: input.qualityScore,
      notesPath: input.notesPath,
      addedBy: input.addedBy,
      createdAt: now,
      lastCheckedAt: now,
    })
    .onConflictDoUpdate({ target: sources.url, set })
    .returning({ id: sources.id })
    .get()!;
}

export function startRun(agent: string): number {
  return db()
    .insert(runs)
    .values({ agent, startedAt: new Date().toISOString() })
    .returning({ id: runs.id })
    .get()!.id;
}

export interface FinishRunPatch {
  status: "success" | "error";
  itemsAdded?: number;
  itemsUpdated?: number;
  numTurns?: number;
  costUsd?: number;
  usageJson?: string;
  sessionId?: string;
  error?: string;
}

export function finishRun(id: number, patch: FinishRunPatch): void {
  db()
    .update(runs)
    .set({ finishedAt: new Date().toISOString(), ...patch })
    .where(eq(runs.id, id))
    .run();
}

export function listRuns(limit = 50) {
  return db().select().from(runs).orderBy(desc(runs.startedAt)).limit(limit).all();
}
