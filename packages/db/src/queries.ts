import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, ne, notInArray, sql } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { db } from "./client";
import { readCategoryConfig, readMapCategories } from "./config";
import { resolvePage } from "./pagination";
import {
  chooseCanonical,
  groupBusinessDuplicates,
  mergeFacts,
} from "./business-dedupe";
import {
  type BusinessSort,
  type SortDir,
  sortRankedBusinesses,
} from "./business-sort";
import { findKey } from "./dedupe";
import {
  type Business,
  type Find,
  type FetchClass,
  type Source,
  businesses,
  feedback,
  fetches,
  finds,
  runs,
  sources,
} from "./schema";

// Exact-element match against a JSON text-array column (tags). Shared by the
// finds feed and the businesses directory so the json_each idiom lives once.
function jsonArrayHas(column: AnySQLiteColumn, value: string) {
  return sql`exists (select 1 from json_each(${column}) where json_each.value = ${value})`;
}

// Escape LIKE metacharacters so a user's search text is matched literally
// (e.g. "50%" must not become a wildcard). Pair with `escape '\'` in the query.
function likeContains(term: string): string {
  return `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

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
  // Free-text find type ("event" default, "lead", ...). cf. finds.type.
  type?: string;
  // FK to a businesses row (a lead's OSM business). Null for non-lead finds.
  businessId?: number | null;
  // 0-1 fit/quality score. Persisted here (insertFind previously dropped it).
  score?: number | null;
  /** Defaults to "new". Set "provisional" for an interview sample run's leads. */
  status?: FindStatus;
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
      type: input.type ?? "event",
      businessId: input.businessId ?? null,
      score: input.score ?? null,
      status: input.status ?? "new",
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
export type FeedSort = "newest" | "oldest" | "soonest";

export interface FeedFilters {
  view?: FeedView;
  days?: number;
  // Inclusive event-date range (ISO YYYY-MM-DD) filtering on eventStart. When
  // set, finds with no eventStart drop out. Distinct from `days`, which is a
  // recently-discovered window over discoveredAt.
  from?: string;
  to?: string;
  tag?: string;
  // Narrow to a single find type (e.g. "lead"). Omit for all types.
  type?: string;
  // Drop these find types (e.g. ["lead"] to hide leads). Applied after `type`.
  excludeTypes?: string[];
  limit?: number;
  page?: number;
  // Positive => paginate; omit/<=0 => the full matching set on one page.
  pageSize?: number;
  sort?: FeedSort;
}

export interface FeedPage {
  rows: Find[];
  total: number;
  page: number;
  pageCount: number;
}

// Items stay visible through their expiry date (date-prefix comparison works
// for both date and datetime ISO strings).
function notExpired() {
  const today = new Date().toISOString().slice(0, 10);
  return sql`(${finds.expiresAt} is null or ${finds.expiresAt} >= ${today})`;
}

// Provisional leads belong to an in-progress interview's sample run and must
// never surface in the feed until promoted to "new".
function notProvisional() {
  return ne(finds.status, "provisional");
}

// Shared WHERE-building for the feed, used by both getFeed (array) and
// getFeedPage (paginated) so their filter semantics never drift.
function feedConditions(filters: FeedFilters) {
  const conditions = [];
  const view = filters.view ?? "default";
  if (view === "default") {
    conditions.push(ne(finds.status, "hidden"), notProvisional(), notExpired());
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
  // Event-date range on eventStart. `to` covers the whole end day, so an event
  // timestamped that evening still matches a same-day upper bound.
  if (filters.from) conditions.push(gte(finds.eventStart, filters.from));
  if (filters.to)
    conditions.push(lte(finds.eventStart, `${filters.to}T23:59:59.999Z`));
  if (filters.tag) {
    // tags is a JSON string array — exact-element match on the serialized form
    conditions.push(jsonArrayHas(finds.tags, filters.tag));
  }
  if (filters.type) conditions.push(eq(finds.type, filters.type));
  if (filters.excludeTypes && filters.excludeTypes.length > 0) {
    conditions.push(notInArray(finds.type, filters.excludeTypes));
  }
  return conditions;
}

// Feed ordering. "newest"/"oldest" use discovery time; "soonest" uses the
// event start date (earliest first), with undated finds pushed to the end.
function feedOrder(sort: FeedSort | undefined) {
  switch (sort) {
    case "oldest":
      return [asc(finds.discoveredAt)];
    case "soonest":
      return [sql`${finds.eventStart} is null`, asc(finds.eventStart)];
    default:
      return [desc(finds.discoveredAt)];
  }
}

export function getFeed(filters: FeedFilters = {}) {
  const conditions = feedConditions(filters);
  return db()
    .select()
    .from(finds)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(finds.discoveredAt))
    .limit(filters.limit ?? 200)
    .all();
}

// Paginated feed for /feed: same filters as getFeed plus page/pageSize/sort,
// returning the page slice with the total match count for the pager.
export function getFeedPage(filters: FeedFilters = {}): FeedPage {
  const conditions = feedConditions(filters);
  const where = conditions.length ? and(...conditions) : undefined;
  const order = feedOrder(filters.sort);

  const total =
    db().select({ n: sql<number>`count(*)` }).from(finds).where(where).get()?.n ??
    0;

  // No page size -> the full matching set on a single page.
  if (!filters.pageSize || filters.pageSize <= 0) {
    const rows = db().select().from(finds).where(where).orderBy(...order).all();
    return { rows, total, page: 1, pageCount: 1 };
  }

  const { page, pageCount, start } = resolvePage(
    total,
    filters.page ?? 1,
    filters.pageSize,
  );
  const rows = db()
    .select()
    .from(finds)
    .where(where)
    .orderBy(...order)
    .limit(filters.pageSize)
    .offset(start)
    .all();
  return { rows, total, page, pageCount };
}

// Distinct tags among currently feed-visible items, for the filter bar.
export function listActiveTags(limit = 30): string[] {
  const rows = db().all<{ tag: string; n: number }>(
    sql`select json_each.value as tag, count(*) as n
        from ${finds}, json_each(${finds.tags})
        where ${finds.status} not in ('hidden', 'provisional') and (${finds.expiresAt} is null or ${finds.expiresAt} >= ${new Date().toISOString().slice(0, 10)})
        group by tag order by n desc limit ${limit}`,
  );
  return rows.map((r) => r.tag);
}

// Distinct find types among currently feed-visible items, for the filter bar.
// Ordered by count desc so the common types (events) lead. "event" always
// appears (it's the default), so a single-type feed still shows one chip.
export function listFindTypes(): string[] {
  const today = new Date().toISOString().slice(0, 10);
  const rows = db().all<{ type: string; n: number }>(
    sql`select ${finds.type} as type, count(*) as n
        from ${finds}
        where ${finds.status} not in ('hidden', 'provisional') and (${finds.expiresAt} is null or ${finds.expiresAt} >= ${today})
        group by ${finds.type} order by n desc`,
  );
  return rows.map((r) => r.type);
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

export type FindStatus = "new" | "shown" | "hidden" | "starred" | "provisional";

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

export function listProvisionalFinds(): Find[] {
  return db().select().from(finds).where(eq(finds.status, "provisional")).all() as Find[];
}

export function promoteProvisionalFinds(): number {
  return db()
    .update(finds)
    .set({ status: "new" })
    .where(eq(finds.status, "provisional"))
    .run().changes;
}

export function discardProvisionalFinds(): number {
  return db().delete(finds).where(eq(finds.status, "provisional")).run().changes;
}

// Bulk status changes for feed management. Status-only (no feedback rows) so a
// sweep of the visible page doesn't flood the agents' taste signal.
export function updateFindStatuses(ids: number[], status: FindStatus): number {
  if (ids.length === 0) return 0;
  return db().update(finds).set({ status }).where(inArray(finds.id, ids)).run()
    .changes;
}

export function unhideAll(): number {
  return db()
    .update(finds)
    .set({ status: "shown" })
    .where(eq(finds.status, "hidden"))
    .run().changes;
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
  // A budget-capped run ("capped") still completed step 1 (read_feedback)
  // before the cap, so it counts as a baseline for "unread feedback" too.
  return (
    db()
      .select({ startedAt: runs.startedAt })
      .from(runs)
      .where(
        and(
          eq(runs.agent, agent),
          inArray(runs.status, ["success", "capped"]),
        ),
      )
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

export function getSourceById(id: number): Source | undefined {
  return db().select().from(sources).where(eq(sources.id, id)).get();
}

export function listFindsBySource(sourceId: number, limit = 10): Find[] {
  return db()
    .select()
    .from(finds)
    .where(eq(finds.sourceId, sourceId))
    .orderBy(desc(finds.discoveredAt))
    .limit(limit)
    .all();
}

export interface UpsertSourceInput {
  url: string;
  name?: string;
  status?: "active" | "paused" | "dead";
  qualityScore?: number;
  notesPath?: string;
  icalUrl?: string;
  addedBy: string;
}

export interface UpsertSourceResult {
  id: number;
  outcome: "created" | "updated";
}

export function upsertSource(input: UpsertSourceInput): UpsertSourceResult {
  const now = new Date().toISOString();
  // Look up existence before the upsert so we can report created vs updated —
  // the run summary counts a brand-new source as "added", a re-check as "updated".
  const existing = db()
    .select({ id: sources.id })
    .from(sources)
    .where(eq(sources.url, input.url))
    .get();

  const set: Record<string, unknown> = { lastCheckedAt: now };
  if (input.name !== undefined) set.name = input.name;
  if (input.status !== undefined) set.status = input.status;
  if (input.qualityScore !== undefined) set.qualityScore = input.qualityScore;
  if (input.notesPath !== undefined) set.notesPath = input.notesPath;
  if (input.icalUrl !== undefined) set.icalUrl = input.icalUrl;
  const row = db()
    .insert(sources)
    .values({
      url: input.url,
      name: input.name,
      status: input.status ?? "active",
      qualityScore: input.qualityScore,
      notesPath: input.notesPath,
      icalUrl: input.icalUrl,
      addedBy: input.addedBy,
      createdAt: now,
      lastCheckedAt: now,
    })
    .onConflictDoUpdate({ target: sources.url, set })
    .returning({ id: sources.id })
    .get()!;

  return { id: row.id, outcome: existing ? "updated" : "created" };
}

export interface UpsertBusinessInput {
  osmId: string;
  name: string;
  kind?: string | null;
  tags?: string[];
  address?: string | null;
  town?: string | null;
  lat?: number | null;
  lng?: number | null;
  website?: string | null;
  phone?: string | null;
  brand?: string | null;
  status?: "active" | "closed" | "unknown";
  notesPath?: string | null;
  addedBy: string;
}

export interface UpsertBusinessResult {
  id: number;
  outcome: "created" | "updated";
}

// Matched by osmId. Only fields the caller actually supplied are overwritten, so
// a sparse re-scan never wipes facts a fuller scan captured. lastSeenAt always
// advances — it's the "still present in OSM" signal for the closure sweep.
export function upsertBusiness(input: UpsertBusinessInput): UpsertBusinessResult {
  const now = new Date().toISOString();
  const existing = db()
    .select({ id: businesses.id })
    .from(businesses)
    .where(eq(businesses.osmId, input.osmId))
    .get();

  const set: Record<string, unknown> = { lastSeenAt: now };
  if (input.name !== undefined) set.name = input.name;
  if (input.kind !== undefined) set.kind = input.kind;
  if (input.tags !== undefined) set.tags = input.tags;
  if (input.address !== undefined) set.address = input.address;
  if (input.town !== undefined) set.town = input.town;
  if (input.lat !== undefined) set.lat = input.lat;
  if (input.lng !== undefined) set.lng = input.lng;
  if (input.website !== undefined) set.website = input.website;
  if (input.phone !== undefined) set.phone = input.phone;
  if (input.brand !== undefined) set.brand = input.brand;
  if (input.status !== undefined) set.status = input.status;
  if (input.notesPath !== undefined) set.notesPath = input.notesPath;

  const row = db()
    .insert(businesses)
    .values({
      osmId: input.osmId,
      name: input.name,
      kind: input.kind ?? null,
      tags: input.tags ?? [],
      address: input.address ?? null,
      town: input.town ?? null,
      lat: input.lat ?? null,
      lng: input.lng ?? null,
      website: input.website ?? null,
      phone: input.phone ?? null,
      brand: input.brand ?? null,
      status: input.status ?? "active",
      notesPath: input.notesPath ?? null,
      addedBy: input.addedBy,
      discoveredAt: now,
      lastSeenAt: now,
    })
    .onConflictDoUpdate({ target: businesses.osmId, set })
    .returning({ id: businesses.id })
    .get()!;

  return { id: row.id, outcome: existing ? "updated" : "created" };
}

export interface BusinessFilters {
  town?: string;
  tag?: string;
  status?: "active" | "closed" | "unknown";
  q?: string;
  limit?: number;
  /** Only rows with a non-empty website (i.e. candidate sources). */
  hasWebsite?: boolean;
  /** Include rows marked as duplicates of another business. Default false. */
  includeDuplicates?: boolean;
}

export function listBusinesses(filters: BusinessFilters = {}) {
  const conditions = [];
  if (!filters.includeDuplicates) conditions.push(isNull(businesses.duplicateOf));
  if (filters.town) conditions.push(eq(businesses.town, filters.town));
  if (filters.status) conditions.push(eq(businesses.status, filters.status));
  if (filters.tag) {
    conditions.push(jsonArrayHas(businesses.tags, filters.tag));
  }
  if (filters.q) {
    conditions.push(
      sql`${businesses.name} like ${likeContains(filters.q)} escape '\\'`,
    );
  }
  if (filters.hasWebsite) {
    conditions.push(sql`${businesses.website} is not null and ${businesses.website} != ''`);
  }
  return db()
    .select()
    .from(businesses)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(businesses.town, businesses.name)
    .limit(filters.limit ?? 500)
    .all();
}

// Collapse OSM elements that describe the same real business (same normalized
// name, within ~50m) into one canonical row. Reads only unmarked rows, so it is
// idempotent; merges the duplicates' missing facts onto the canonical, then
// points each loser's duplicate_of at the canonical osm_id. Run after a
// cartographer scan and as a one-time cleanup. Facts are merged onto the
// canonical once, at collapse time; a later re-scan of an already-marked
// duplicate does not re-merge its newly-changed facts.
export function dedupeBusinesses(): { groups: number; marked: number } {
  const rows = db()
    .select()
    .from(businesses)
    .where(isNull(businesses.duplicateOf))
    .all();

  const groups = groupBusinessDuplicates(rows);
  let marked = 0;

  db().transaction((tx) => {
    for (const group of groups) {
      const canonical = chooseCanonical(group);
      const others = group.filter((r) => r.id !== canonical.id);

      const fill = mergeFacts(canonical, others);
      if (Object.keys(fill).length > 0) {
        tx.update(businesses).set(fill).where(eq(businesses.id, canonical.id)).run();
      }

      for (const dup of others) {
        tx.update(businesses)
          .set({ duplicateOf: canonical.osmId })
          .where(eq(businesses.id, dup.id))
          .run();
        marked++;
      }
    }
  });

  return { groups: groups.length, marked };
}

export interface RankedBusiness {
  business: Business;
  /** Search-priority tier (1 = highest) from categories.json. */
  tier: number;
  /** OSM brand present = national/regional chain. */
  isChain: boolean;
}

export interface RankedBusinessFilters extends BusinessFilters {
  /** Drop rows whose tier is worse (numerically greater) than this. */
  maxTier?: number;
  /** Include Tier-4 ("not a business") rows. Defaults to the config's hide rule. */
  includeTier4?: boolean;
  /** Include chains. Defaults to the config's hide rule. */
  includeChains?: boolean;
  /** 1-indexed page (default 1). Ignored unless `pageSize` is set. */
  page?: number;
  /** Positive page size. Omit (or <= 0) to return the full ranked set. */
  pageSize?: number;
  /** Column sort. Omit for the default search-priority ranking. */
  sort?: BusinessSort;
  /** Sort direction (default "asc"). Ignored when `sort` is omitted. */
  dir?: SortDir;
}

export interface RankedBusinessList {
  /** The current page of ranked rows (or the full set when not paging). */
  rows: RankedBusiness[];
  /** Total rows matching the DB filters, before tier/chain visibility. */
  total: number;
  /** Rows after tier4/chain visibility — the set being paged. */
  matched: number;
  /** Clamped current page (1 when not paging). */
  page: number;
  /** Total pages (1 when not paging, or when `matched` is 0). */
  pageCount: number;
  tier4Count: number;
  chainCount: number;
}

// Annotate each business with its search-priority tier + chain flag, apply the
// tier4/chain visibility rules, then order via sortRankedBusinesses — the
// default (no `sort` filter) is chains-last then tier then name, overridden by
// the `sort`/`dir` filters. One place owns "rank/exclude by search priority" —
// the /businesses page and the agents' list_businesses tool both use it instead
// of re-deriving it.
export function listBusinessesRanked(
  filters: RankedBusinessFilters = {},
): RankedBusinessList {
  const cfg = readCategoryConfig();
  const showTier4 = filters.includeTier4 ?? !cfg.hideInDirectory.tier4;
  const showChains = filters.includeChains ?? !cfg.hideInDirectory.chains;

  const annotated: RankedBusiness[] = listBusinesses(filters).map((business) => ({
    business,
    tier: cfg.tierOf(business.kind),
    isChain: Boolean(business.brand),
  }));

  let tier4Count = 0;
  let chainCount = 0;
  for (const a of annotated) {
    if (a.tier === 4) tier4Count++;
    if (a.isChain) chainCount++;
  }

  const visible = annotated.filter(
    (a) =>
      (showTier4 || a.tier !== 4) &&
      (showChains || !a.isChain) &&
      (filters.maxTier == null || a.tier <= filters.maxTier),
  );
  const ordered = sortRankedBusinesses(visible, filters.sort, filters.dir ?? "asc");

  const matched = ordered.length;
  let rows = ordered;
  let page = 1;
  let pageCount = 1;
  if (filters.pageSize && filters.pageSize > 0) {
    const win = resolvePage(matched, filters.page ?? 1, filters.pageSize);
    page = win.page;
    pageCount = win.pageCount;
    rows = ordered.slice(win.start, win.end);
  }

  return { rows, total: annotated.length, matched, page, pageCount, tier4Count, chainCount };
}

export function getBusinessById(id: number): Business | undefined {
  return db().select().from(businesses).where(eq(businesses.id, id)).get();
}

export interface MapPin {
  id: number;
  name: string;
  kind: string | null;
  lat: number;
  lng: number;
  town: string | null;
  status: "active" | "closed" | "unknown";
  isChain: boolean;
  /** Search-priority tier from categories.json. */
  tier: number;
  /** Theme key from map-categories.json ("other" fallback). */
  theme: string;
  /** Friendly sub-type label, or null. */
  subtype: string | null;
  /** Config key the kind matched (e.g. "shop=*"), for sub-type filtering. Null = Other. */
  subtypeKey: string | null;
  tags: string[];
}

// Every coordinate-bearing, non-duplicate business, annotated for the region map.
// No row limit — the single source for the dashboard map and the /map page.
export function listMapPins(): MapPin[] {
  const cfg = readCategoryConfig();
  const mapCfg = readMapCategories();
  const rows = db()
    .select()
    .from(businesses)
    .where(
      and(
        isNull(businesses.duplicateOf),
        isNotNull(businesses.lat),
        isNotNull(businesses.lng),
      ),
    )
    .all();
  return rows.map((b) => {
    const t = mapCfg.themeOf(b.kind);
    return {
      id: b.id,
      name: b.name,
      kind: b.kind,
      lat: b.lat as number,
      lng: b.lng as number,
      town: b.town,
      status: b.status,
      isChain: Boolean(b.brand),
      tier: cfg.tierOf(b.kind),
      theme: t.key,
      subtype: t.subtype,
      subtypeKey: t.subtypeKey,
      tags: b.tags,
    };
  });
}

// Total catalogued businesses (non-duplicate), incl. coordinate-less rows pins omit.
export function countBusinesses(): number {
  const row = db()
    .select({ n: sql<number>`count(*)` })
    .from(businesses)
    .where(isNull(businesses.duplicateOf))
    .get();
  return row?.n ?? 0;
}

// Distinct towns with business counts, for the directory's town filter.
// Excludes duplicate-marked rows so the pill counts match the deduped listing.
export function listBusinessTowns(): { town: string; n: number }[] {
  return db().all<{ town: string; n: number }>(
    sql`select ${businesses.town} as town, count(*) as n
        from ${businesses}
        where ${businesses.town} is not null
          and ${businesses.duplicateOf} is null
        group by town order by town`,
  );
}

export function startRun(agent: string): number {
  return db()
    .insert(runs)
    .values({ agent, startedAt: new Date().toISOString() })
    .returning({ id: runs.id })
    .get()!.id;
}

export interface FinishRunPatch {
  status: "success" | "capped" | "error";
  itemsAdded?: number;
  itemsUpdated?: number;
  warnings?: number;
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

export function getRun(id: number) {
  return db().select().from(runs).where(eq(runs.id, id)).get();
}

export function recordFetch(input: {
  runId: number;
  agent: string;
  host: string;
  url: string;
  status: number | null;
  klass: FetchClass;
  via?: string;
}): void {
  db()
    .insert(fetches)
    .values({
      runId: input.runId,
      agent: input.agent,
      host: input.host,
      url: input.url,
      status: input.status,
      klass: input.klass,
      via: input.via ?? "webfetch",
      ts: new Date().toISOString(),
    })
    .run();
}

// Manual un-block: drop a host's fetch history so it is no longer hard-blocked.
export function clearFetchHistory(host: string): number {
  return db().delete(fetches).where(eq(fetches.host, host)).run().changes;
}

export function listFetchesForHost(host: string) {
  return db()
    .select()
    .from(fetches)
    .where(eq(fetches.host, host))
    .orderBy(asc(fetches.id))
    .all();
}

// Hosts to hard-block: those whose most-recent `strikes` fetch outcomes were
// all blocked (403/401), uninterrupted. Newest-first is by id (insertion order),
// which is monotonic and deterministic — no dependence on ts clock resolution.
export function blockedHosts(strikes = 3): string[] {
  const rows = db()
    .select({ host: fetches.host, klass: fetches.klass })
    .from(fetches)
    .orderBy(desc(fetches.id))
    .limit(2000)
    .all();

  const state = new Map<string, { streak: number; done: boolean }>();
  const blocked: string[] = [];
  for (const r of rows) {
    const s = state.get(r.host) ?? { streak: 0, done: false };
    if (s.done) continue;
    if (r.klass === "blocked") {
      s.streak += 1;
      if (s.streak >= strikes && !blocked.includes(r.host)) blocked.push(r.host);
    } else {
      s.done = true; // first non-blocked (newest-first) ends this host's streak
    }
    state.set(r.host, s);
  }
  return blocked;
}
