import { chooseCanonical, groupBusinessDuplicates } from "./business-dedupe";
import {
  type BusinessSort,
  type SortDir,
  sortRankedBusinesses,
} from "./business-sort";
import { execute, query, queryOne, tx } from "./client";
import { readCategoryConfig, readMapCategories } from "./config";
import { findKey } from "./dedupe";
import { resolvePage } from "./pagination";
import type {
  Fetch,
  FetchClass,
  FeedbackAction,
  Find,
  FindStatus,
  Place,
  Run,
  Source,
} from "./schema";

// Build $N placeholders for a dynamic query: each call pushes a value onto the
// shared params array and returns its positional placeholder. Keeps every value
// parameterized (never string-interpolated) even in dynamically-assembled WHERE.
function pusher(params: unknown[]) {
  return (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
}

// Escape LIKE/ILIKE metacharacters so a user's search text is matched literally
// (e.g. "50%" must not become a wildcard). Pair with `escape '\'` in the query.
function likeContains(term: string): string {
  return `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

// --- Column lists: SQL returns snake_case; alias to the camelCase row types.
// One constant per table keeps the aliases DRY and avoids SELECT *.

const FIND_COLS = `id, title, url, url_hash AS "urlHash", summary,
  event_start AS "eventStart", event_end AS "eventEnd", expires_at AS "expiresAt",
  published_at AS "publishedAt", discovered_at AS "discoveredAt", status, agent,
  source_id AS "sourceId", tags, score, type, place_osm_id AS "placeOsmId"`;

const SOURCE_COLS = `id, url, name, notes_path AS "notesPath", ical_url AS "icalUrl",
  status, quality_score AS "qualityScore", finds_count AS "findsCount",
  last_find_at AS "lastFindAt", last_checked_at AS "lastCheckedAt",
  added_by AS "addedBy", created_at AS "createdAt"`;

const RUN_COLS = `id, agent, started_at AS "startedAt", finished_at AS "finishedAt",
  status, items_added AS "itemsAdded", items_updated AS "itemsUpdated", warnings,
  num_turns AS "numTurns", cost_usd AS "costUsd", usage_json::text AS "usageJson",
  session_id AS "sessionId", error`;

const FETCH_COLS = `id, run_id AS "runId", agent, host, url, method, status, klass, via, ts`;

// localfinds.places is osm_places ⋈ annotations; geom/point are NOT selected.
// tags is the full OSM jsonb tag set, bridged to a key=value[] (C7).
const PLACE_TAGS_SQL = `COALESCE(
  (SELECT array_agg(kv.key || '=' || kv.value ORDER BY kv.key)
   FROM jsonb_each_text(pl.tags) AS kv), '{}'::text[])`;

const PLACE_COLS = `pl.osm_id AS "osmId", pl.name, pl.kind, pl.lat, pl.lng,
  pl.town, pl.address, pl.website, pl.phone, pl.brand,
  ${PLACE_TAGS_SQL} AS tags,
  pl.status, pl.status_override AS "statusOverride",
  pl.annotation_note AS "annotationNote", pl.duplicate_of AS "duplicateOf"`;

// ===========================================================================
// Finds + feed (the gated group)
// ===========================================================================

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
  // The OSM place a lead points at. insertFind upserts the annotation anchor so
  // the place_osm_id FK always resolves. Null for non-lead finds.
  placeOsmId?: string | null;
  // 0-1 fit/quality score.
  score?: number | null;
  /** Defaults to "new". Set "provisional" for an interview sample run's leads. */
  status?: FindStatus;
}

export interface SaveFindResult {
  outcome: "created" | "duplicate";
  id: number;
}

export async function insertFind(input: NewFindInput): Promise<SaveFindResult> {
  const urlHash = findKey({ url: input.url, title: input.title });

  let sourceId: number | undefined;
  if (input.sourceUrl) {
    sourceId = (
      await queryOne<{ id: number }>(`SELECT id FROM localfinds.sources WHERE url = $1`, [
        input.sourceUrl,
      ])
    )?.id;
  }

  // Lead→place link contract (SP1): ensure the annotation anchor exists before
  // the FK insert so place_osm_id always resolves. No-op for non-lead finds.
  if (input.placeOsmId) {
    await execute(
      `INSERT INTO localfinds.place_annotations (osm_id, added_by) VALUES ($1, $2)
       ON CONFLICT (osm_id) DO NOTHING`,
      [input.placeOsmId, input.agent],
    );
  }

  const inserted = await queryOne<{ id: number }>(
    `INSERT INTO localfinds.finds
       (title, url, url_hash, summary, event_start, event_end, expires_at, published_at,
        agent, source_id, tags, score, type, place_osm_id, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (url_hash) DO NOTHING
     RETURNING id`,
    [
      input.title,
      input.url ?? null,
      urlHash,
      input.summary ?? null,
      input.eventStart ?? null,
      input.eventEnd ?? null,
      input.expiresAt ?? null,
      input.publishedAt ?? null,
      input.agent,
      sourceId ?? null,
      input.tags ?? [],
      input.score ?? null,
      input.type ?? "event",
      input.placeOsmId ?? null,
      input.status ?? "new",
    ],
  );

  if (inserted) {
    if (sourceId !== undefined) {
      await execute(
        `UPDATE localfinds.sources SET finds_count = finds_count + 1, last_find_at = now()
         WHERE id = $1`,
        [sourceId],
      );
    }
    return { outcome: "created", id: inserted.id };
  }

  const existing = await queryOne<{ id: number }>(
    `SELECT id FROM localfinds.finds WHERE url_hash = $1`,
    [urlHash],
  );
  return { outcome: "duplicate", id: existing!.id };
}

export type FeedView = "default" | "starred" | "hidden" | "all";
export type FeedSort = "newest" | "oldest" | "soonest";

export interface FeedFilters {
  view?: FeedView;
  days?: number;
  // Inclusive event-date range (ISO YYYY-MM-DD) filtering on eventStart. When
  // set, finds with no eventStart drop out.
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

// Shared WHERE-building for the feed, used by both getFeed and getFeedPage so
// their filter semantics never drift. Items stay visible through their expiry
// date (date-prefix comparison works for both date and datetime ISO strings).
function feedWhere(filters: FeedFilters, params: unknown[]): string {
  const p = pusher(params);
  const where: string[] = [];
  const view = filters.view ?? "default";
  const today = new Date().toISOString().slice(0, 10);
  if (view === "default") {
    where.push(
      `status <> 'hidden'`,
      `status <> 'provisional'`,
      `(expires_at IS NULL OR expires_at >= ${p(today)})`,
    );
  }
  if (view === "starred") {
    where.push(`status = 'starred'`, `(expires_at IS NULL OR expires_at >= ${p(today)})`);
  }
  if (view === "hidden") where.push(`status = 'hidden'`);
  if (filters.days) {
    where.push(
      `discovered_at >= ${p(new Date(Date.now() - filters.days * 864e5).toISOString())}`,
    );
  }
  if (filters.from) where.push(`event_start >= ${p(filters.from)}`);
  if (filters.to) where.push(`event_start <= ${p(`${filters.to}T23:59:59.999Z`)}`);
  if (filters.tag) where.push(`${p(filters.tag)} = ANY(tags)`);
  if (filters.type) where.push(`type = ${p(filters.type)}`);
  if (filters.excludeTypes?.length) where.push(`type <> ALL(${p(filters.excludeTypes)})`);
  return where.length ? `WHERE ${where.join(" AND ")}` : "";
}

// Feed ordering. "newest"/"oldest" use discovery time; "soonest" uses the event
// start date (earliest first), with undated finds pushed to the end.
function feedOrderSql(sort: FeedSort | undefined): string {
  switch (sort) {
    case "oldest":
      return "ORDER BY discovered_at ASC";
    case "soonest":
      return "ORDER BY (event_start IS NULL), event_start ASC";
    default:
      return "ORDER BY discovered_at DESC";
  }
}

export async function getFeed(filters: FeedFilters = {}): Promise<Find[]> {
  const params: unknown[] = [];
  const whereSql = feedWhere(filters, params);
  const lp = pusher(params);
  return query<Find>(
    `SELECT ${FIND_COLS} FROM localfinds.finds ${whereSql}
     ORDER BY discovered_at DESC LIMIT ${lp(filters.limit ?? 200)}`,
    params,
  );
}

// Paginated feed for /feed: same filters as getFeed plus page/pageSize/sort,
// returning the page slice with the total match count for the pager.
export async function getFeedPage(filters: FeedFilters = {}): Promise<FeedPage> {
  const params: unknown[] = [];
  const whereSql = feedWhere(filters, params);
  const total =
    (
      await queryOne<{ n: number }>(
        `SELECT count(*)::int AS n FROM localfinds.finds ${whereSql}`,
        params,
      )
    )?.n ?? 0;
  const order = feedOrderSql(filters.sort);

  // No page size -> the full matching set on a single page.
  if (!filters.pageSize || filters.pageSize <= 0) {
    const rows = await query<Find>(
      `SELECT ${FIND_COLS} FROM localfinds.finds ${whereSql} ${order}`,
      params,
    );
    return { rows, total, page: 1, pageCount: 1 };
  }

  const { page, pageCount, start } = resolvePage(total, filters.page ?? 1, filters.pageSize);
  const lp = pusher(params);
  const rows = await query<Find>(
    `SELECT ${FIND_COLS} FROM localfinds.finds ${whereSql} ${order}
     LIMIT ${lp(filters.pageSize)} OFFSET ${lp(start)}`,
    params,
  );
  return { rows, total, page, pageCount };
}

// Distinct tags among currently feed-visible items, for the filter bar.
export async function listActiveTags(limit = 30): Promise<string[]> {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await query<{ tag: string }>(
    `SELECT t AS tag, count(*) AS n FROM localfinds.finds, unnest(tags) AS t
     WHERE status NOT IN ('hidden', 'provisional')
       AND (expires_at IS NULL OR expires_at >= $1)
     GROUP BY t ORDER BY n DESC LIMIT $2`,
    [today, limit],
  );
  return rows.map((r) => r.tag);
}

// Distinct find types among currently feed-visible items, for the filter bar.
// Ordered by count desc so the common types (events) lead.
export async function listFindTypes(): Promise<string[]> {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await query<{ type: string }>(
    `SELECT type, count(*) AS n FROM localfinds.finds
     WHERE status NOT IN ('hidden', 'provisional')
       AND (expires_at IS NULL OR expires_at >= $1)
     GROUP BY type ORDER BY n DESC`,
    [today],
  );
  return rows.map((r) => r.type);
}

// First render of a `new` find flips it to `shown`.
export async function markFindsShown(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await execute(
    `UPDATE localfinds.finds SET status = 'shown' WHERE id = ANY($1) AND status = 'new'`,
    [ids],
  );
}

export async function listRecentFinds(
  opts: { days?: number; status?: FindStatus; limit?: number } = {},
): Promise<Find[]> {
  const since = new Date(Date.now() - (opts.days ?? 7) * 864e5).toISOString();
  const params: unknown[] = [];
  const p = pusher(params);
  const where = [`discovered_at >= ${p(since)}`];
  if (opts.status) where.push(`status = ${p(opts.status)}`);
  else where.push(`status <> 'provisional'`);
  const lim = p(opts.limit ?? 100);
  return query<Find>(
    `SELECT ${FIND_COLS} FROM localfinds.finds WHERE ${where.join(" AND ")}
     ORDER BY discovered_at DESC LIMIT ${lim}`,
    params,
  );
}

export async function updateFindStatus(id: number, status: FindStatus): Promise<boolean> {
  return (await execute(`UPDATE localfinds.finds SET status = $1 WHERE id = $2`, [status, id])) > 0;
}

export async function setFindExpiry(id: number, expiresAt: string): Promise<boolean> {
  return (
    (await execute(`UPDATE localfinds.finds SET expires_at = $1 WHERE id = $2`, [expiresAt, id])) > 0
  );
}

export async function listProvisionalFinds(): Promise<Find[]> {
  return query<Find>(`SELECT ${FIND_COLS} FROM localfinds.finds WHERE status = 'provisional'`);
}

export async function promoteProvisionalFinds(): Promise<number> {
  return execute(`UPDATE localfinds.finds SET status = 'new' WHERE status = 'provisional'`);
}

export async function discardProvisionalFinds(): Promise<number> {
  return execute(`DELETE FROM localfinds.finds WHERE status = 'provisional'`);
}

// Bulk status changes for feed management. Status-only (no feedback rows) so a
// sweep of the visible page doesn't flood the agents' taste signal.
export async function updateFindStatuses(ids: number[], status: FindStatus): Promise<number> {
  if (ids.length === 0) return 0;
  return execute(`UPDATE localfinds.finds SET status = $1 WHERE id = ANY($2)`, [status, ids]);
}

export async function unhideAll(): Promise<number> {
  return execute(`UPDATE localfinds.finds SET status = 'shown' WHERE status = 'hidden'`);
}

export async function recordFeedback(
  findId: number,
  action: FeedbackAction,
  note?: string,
): Promise<void> {
  await execute(`INSERT INTO localfinds.feedback (find_id, action, note) VALUES ($1, $2, $3)`, [
    findId,
    action,
    note ?? null,
  ]);
}

// A budget-capped run ("capped") still completed step 1 (read_feedback) before
// the cap, so it counts as a baseline for "unread feedback" too.
async function lastSuccessfulRunStart(agent: string): Promise<string | null> {
  const row = await queryOne<{ startedAt: string }>(
    `SELECT started_at AS "startedAt" FROM localfinds.runs
     WHERE agent = $1 AND status IN ('success', 'capped')
     ORDER BY started_at DESC LIMIT 1`,
    [agent],
  );
  return row?.startedAt ?? null;
}

export interface AgentFeedback {
  id: number;
  action: FeedbackAction;
  note: string | null;
  createdAt: string;
  findId: number;
  findTitle: string;
  findUrl: string | null;
  findTags: string[];
  foundBy: string;
}

// An agent's "unread feedback" is everything newer than its last successful run.
export async function readFeedbackForAgent(agent: string, limit = 200): Promise<AgentFeedback[]> {
  const cutoff = await lastSuccessfulRunStart(agent);
  const params: unknown[] = [];
  const p = pusher(params);
  const where = cutoff ? `WHERE fb.created_at >= ${p(cutoff)}` : "";
  const lim = p(limit);
  return query<AgentFeedback>(
    `SELECT fb.id, fb.action, fb.note, fb.created_at AS "createdAt", fb.find_id AS "findId",
            f.title AS "findTitle", f.url AS "findUrl", f.tags AS "findTags", f.agent AS "foundBy"
     FROM localfinds.feedback fb
     INNER JOIN localfinds.finds f ON fb.find_id = f.id
     ${where}
     ORDER BY fb.created_at DESC LIMIT ${lim}`,
    params,
  );
}

export async function costLastNDays(days = 30): Promise<number> {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const row = await queryOne<{ total: number | null }>(
    `SELECT sum(cost_usd) AS total FROM localfinds.runs WHERE started_at >= $1`,
    [since],
  );
  return row?.total ?? 0;
}

// ===========================================================================
// Sources
// ===========================================================================

export async function listSources(): Promise<Source[]> {
  return query<Source>(`SELECT ${SOURCE_COLS} FROM localfinds.sources ORDER BY url`);
}

export async function getSourceById(id: number): Promise<Source | undefined> {
  return queryOne<Source>(`SELECT ${SOURCE_COLS} FROM localfinds.sources WHERE id = $1`, [id]);
}

export async function listFindsBySource(sourceId: number, limit = 10): Promise<Find[]> {
  return query<Find>(
    `SELECT ${FIND_COLS} FROM localfinds.finds WHERE source_id = $1
     ORDER BY discovered_at DESC LIMIT $2`,
    [sourceId, limit],
  );
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

// Look up existence before the upsert so we can report created vs updated. Only
// fields the caller supplied are overwritten; last_checked_at always advances.
export async function upsertSource(input: UpsertSourceInput): Promise<UpsertSourceResult> {
  const existing = await queryOne<{ id: number }>(
    `SELECT id FROM localfinds.sources WHERE url = $1`,
    [input.url],
  );

  const params: unknown[] = [];
  const p = pusher(params);
  const set = [`last_checked_at = now()`];
  if (input.name !== undefined) set.push(`name = ${p(input.name)}`);
  if (input.status !== undefined) set.push(`status = ${p(input.status)}`);
  if (input.qualityScore !== undefined) set.push(`quality_score = ${p(input.qualityScore)}`);
  if (input.notesPath !== undefined) set.push(`notes_path = ${p(input.notesPath)}`);
  if (input.icalUrl !== undefined) set.push(`ical_url = ${p(input.icalUrl)}`);

  const row = await queryOne<{ id: number }>(
    `INSERT INTO localfinds.sources
       (url, name, status, quality_score, notes_path, ical_url, added_by, last_checked_at)
     VALUES (${p(input.url)}, ${p(input.name ?? null)}, ${p(input.status ?? "active")},
             ${p(input.qualityScore ?? null)}, ${p(input.notesPath ?? null)},
             ${p(input.icalUrl ?? null)}, ${p(input.addedBy)}, now())
     ON CONFLICT (url) DO UPDATE SET ${set.join(", ")}
     RETURNING id`,
    params,
  );
  return { id: row!.id, outcome: existing ? "updated" : "created" };
}

// ===========================================================================
// Places (osm_places ⋈ annotations via localfinds.places). Read-only catalog;
// the LocalFinds-owned overlay (status_override, note, duplicate_of) is writable
// via place_annotations. Dedicated tests land in Tasks 5–6.
// ===========================================================================

export interface BusinessFilters {
  town?: string;
  tag?: string;
  status?: "active" | "closed" | "unknown";
  q?: string;
  limit?: number;
  /** Only rows with a non-empty website (i.e. candidate sources). */
  hasWebsite?: boolean;
  /** Include rows marked as duplicates of another place. Default false. */
  includeDuplicates?: boolean;
}

export async function listBusinesses(filters: BusinessFilters = {}): Promise<Place[]> {
  const params: unknown[] = [];
  const p = pusher(params);
  const where: string[] = [];
  if (!filters.includeDuplicates) where.push(`pl.duplicate_of IS NULL`);
  if (filters.town) where.push(`pl.town = ${p(filters.town)}`);
  if (filters.status) where.push(`pl.status = ${p(filters.status)}`);
  if (filters.tag) {
    // The catalog tags column is the raw OSM jsonb set. The filter is an OSM
    // key existence check (e.g. "amenity" → any amenity place). This matches
    // the old SQLite "array contains key" semantics while letting PLACE_TAGS_SQL
    // still return the full derived key=value[] for display (C7). To filter by
    // a specific value, callers should use BusinessFilters.kind (TODO).
    where.push(`pl.tags ? ${p(filters.tag)}`);
  }
  if (filters.q) where.push(`pl.name ILIKE ${p(likeContains(filters.q))} ESCAPE '\\'`);
  if (filters.hasWebsite) where.push(`pl.website IS NOT NULL AND pl.website <> ''`);
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const lim = p(filters.limit ?? 500);
  return query<Place>(
    `SELECT ${PLACE_COLS} FROM localfinds.places pl ${whereSql}
     ORDER BY pl.town, pl.name LIMIT ${lim}`,
    params,
  );
}

export async function getPlaceByOsmId(osmId: string): Promise<Place | undefined> {
  return queryOne<Place>(`SELECT ${PLACE_COLS} FROM localfinds.places pl WHERE pl.osm_id = $1`, [
    osmId,
  ]);
}

// Collapse OSM elements that describe the same real place (same normalized name,
// within ~50m) by marking the losers' place_annotations.duplicate_of with the
// canonical osm_id. Reads only unmarked rows, so it is idempotent. Facts are NOT
// merged (the osm_places matview is read-only — facts come from OSM).
export async function dedupeBusinesses(): Promise<{ groups: number; marked: number }> {
  const rows = await listBusinesses({ limit: 1_000_000 });
  const groups = groupBusinessDuplicates(rows);
  let marked = 0;

  await tx(async (c) => {
    for (const group of groups) {
      const canonical = chooseCanonical(group);
      for (const dup of group) {
        if (dup.osmId === canonical.osmId) continue;
        await c.query(
          `INSERT INTO localfinds.place_annotations (osm_id, duplicate_of, added_by)
           VALUES ($1, $2, 'dedupe')
           ON CONFLICT (osm_id) DO UPDATE SET duplicate_of = EXCLUDED.duplicate_of, updated_at = now()`,
          [dup.osmId, canonical.osmId],
        );
        marked++;
      }
    }
  });

  return { groups: groups.length, marked };
}

export interface RankedBusiness {
  business: Place;
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
  rows: RankedBusiness[];
  total: number;
  matched: number;
  page: number;
  pageCount: number;
  tier4Count: number;
  chainCount: number;
}

// Annotate each place with its search-priority tier + chain flag, apply the
// tier4/chain visibility rules, then order via sortRankedBusinesses. One place
// owns "rank/exclude by search priority" — the /businesses page and the agents'
// list_businesses tool both use it instead of re-deriving it.
export async function listBusinessesRanked(
  filters: RankedBusinessFilters = {},
): Promise<RankedBusinessList> {
  const cfg = readCategoryConfig();
  const showTier4 = filters.includeTier4 ?? !cfg.hideInDirectory.tier4;
  const showChains = filters.includeChains ?? !cfg.hideInDirectory.chains;

  const annotated: RankedBusiness[] = (await listBusinesses(filters)).map((business) => ({
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

export interface MapPin {
  osmId: string;
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

// Every coordinate-bearing, non-duplicate place, annotated for the region map.
// No row limit — the single source for the dashboard map and the /map page.
export async function listMapPins(): Promise<MapPin[]> {
  const cfg = readCategoryConfig();
  const mapCfg = readMapCategories();
  const rows = await query<Place>(
    `SELECT ${PLACE_COLS} FROM localfinds.places pl
     WHERE pl.duplicate_of IS NULL AND pl.lat IS NOT NULL AND pl.lng IS NOT NULL`,
  );
  return rows.map((b) => {
    const t = mapCfg.themeOf(b.kind);
    return {
      osmId: b.osmId,
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

// Total catalogued places (non-duplicate), incl. coordinate-less rows pins omit.
export async function countBusinesses(): Promise<number> {
  const row = await queryOne<{ n: number }>(
    `SELECT count(*)::int AS n FROM localfinds.places pl WHERE pl.duplicate_of IS NULL`,
  );
  return row?.n ?? 0;
}

// Distinct towns with place counts, for the directory's town filter. Excludes
// duplicate-marked rows so the pill counts match the deduped listing.
export async function listBusinessTowns(): Promise<{ town: string; n: number }[]> {
  return query<{ town: string; n: number }>(
    `SELECT pl.town AS town, count(*)::int AS n FROM localfinds.places pl
     WHERE pl.town IS NOT NULL AND pl.duplicate_of IS NULL
     GROUP BY pl.town ORDER BY pl.town`,
  );
}

// ===========================================================================
// Runs
// ===========================================================================

export async function startRun(agent: string): Promise<number> {
  const row = await queryOne<{ id: number }>(
    `INSERT INTO localfinds.runs (agent) VALUES ($1) RETURNING id`,
    [agent],
  );
  return row!.id;
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

export async function finishRun(id: number, patch: FinishRunPatch): Promise<void> {
  const params: unknown[] = [];
  const p = pusher(params);
  const set = [`finished_at = now()`, `status = ${p(patch.status)}`];
  if (patch.itemsAdded !== undefined) set.push(`items_added = ${p(patch.itemsAdded)}`);
  if (patch.itemsUpdated !== undefined) set.push(`items_updated = ${p(patch.itemsUpdated)}`);
  if (patch.warnings !== undefined) set.push(`warnings = ${p(patch.warnings)}`);
  if (patch.numTurns !== undefined) set.push(`num_turns = ${p(patch.numTurns)}`);
  if (patch.costUsd !== undefined) set.push(`cost_usd = ${p(patch.costUsd)}`);
  if (patch.usageJson !== undefined) set.push(`usage_json = ${p(patch.usageJson)}`);
  if (patch.sessionId !== undefined) set.push(`session_id = ${p(patch.sessionId)}`);
  if (patch.error !== undefined) set.push(`error = ${p(patch.error)}`);
  await execute(`UPDATE localfinds.runs SET ${set.join(", ")} WHERE id = ${p(id)}`, params);
}

export async function listRuns(limit = 50): Promise<Run[]> {
  return query<Run>(`SELECT ${RUN_COLS} FROM localfinds.runs ORDER BY started_at DESC LIMIT $1`, [
    limit,
  ]);
}

export async function getRun(id: number): Promise<Run | undefined> {
  return queryOne<Run>(`SELECT ${RUN_COLS} FROM localfinds.runs WHERE id = $1`, [id]);
}

// ===========================================================================
// Fetches
// ===========================================================================

export async function recordFetch(input: {
  runId: number;
  agent: string;
  host: string;
  url: string;
  status: number | null;
  klass: FetchClass;
  via?: string;
}): Promise<void> {
  await execute(
    `INSERT INTO localfinds.fetches (run_id, agent, host, url, status, klass, via)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [input.runId, input.agent, input.host, input.url, input.status, input.klass, input.via ?? "webfetch"],
  );
}

// Manual un-block: drop a host's fetch history so it is no longer hard-blocked.
export async function clearFetchHistory(host: string): Promise<number> {
  return execute(`DELETE FROM localfinds.fetches WHERE host = $1`, [host]);
}

export async function listFetchesForHost(host: string): Promise<Fetch[]> {
  return query<Fetch>(`SELECT ${FETCH_COLS} FROM localfinds.fetches WHERE host = $1 ORDER BY id ASC`, [
    host,
  ]);
}

// Hosts to hard-block: those whose most-recent `strikes` fetch outcomes were all
// blocked (403/401), uninterrupted. Newest-first is by id (insertion order),
// which is monotonic and deterministic — no dependence on ts clock resolution.
export async function blockedHosts(strikes = 3): Promise<string[]> {
  const rows = await query<{ host: string; klass: string }>(
    `SELECT host, klass FROM localfinds.fetches ORDER BY id DESC LIMIT 2000`,
  );

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
