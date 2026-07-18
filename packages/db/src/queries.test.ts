import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { resetDb, setupPgDatabase, teardownPgDatabase } from "../test/harness";
import { execute, queryOne } from "./client";
import * as q from "./queries";

beforeAll(setupPgDatabase, 120_000);
afterAll(teardownPgDatabase);
afterEach(resetDb);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("insertFind", () => {
  it("creates then reports a duplicate on the same url+title", async () => {
    const a = await q.insertFind({
      title: "Fair",
      url: "https://x.test/e",
      agent: "scout",
      tags: ["fair"],
    });
    expect(a.outcome).toBe("created");
    const b = await q.insertFind({ title: "Fair", url: "https://x.test/e", agent: "scout" });
    expect(b).toEqual({ outcome: "duplicate", id: a.id });
  });

  it("dedupes url variants (utm/scheme/www) of the same titled item", async () => {
    const first = await q.insertFind({
      title: "Concert at the park",
      url: "https://www.example.com/concert/?utm_source=newsletter",
      agent: "scout",
    });
    expect(first.outcome).toBe("created");
    const second = await q.insertFind({
      title: "Concert at the park",
      url: "http://example.com/concert",
      agent: "scout",
    });
    expect(second).toEqual({ outcome: "duplicate", id: first.id });
  });

  it("keeps distinct events that share one listing URL", async () => {
    const walk = await q.insertFind({
      title: "Summer Ecology Walk",
      url: "https://merryspring.org/calendar/",
      agent: "scout",
    });
    const rose = await q.insertFind({
      title: "Rose Day: Lecture & Garden Walk",
      url: "https://merryspring.org/calendar/",
      agent: "scout",
    });
    expect(walk.outcome).toBe("created");
    expect(rose.outcome).toBe("created");
    expect(rose.id).not.toBe(walk.id);
  });

  it("links a find to its source and bumps the source's finds_count", async () => {
    const url = "https://src.example.org";
    const { id: sourceId } = await q.upsertSource({ url, name: "Src", addedBy: "test" });
    const f = await q.insertFind({
      title: "From a source",
      url: `${url}/a`,
      agent: "scout",
      sourceUrl: url,
    });
    expect(f.outcome).toBe("created");
    const rows = await q.listFindsBySource(sourceId);
    expect(rows.map((r) => r.id)).toEqual([f.id]);
    const src = await q.getSourceById(sourceId);
    expect(src?.findsCount).toBe(1);
    expect(src?.lastFindAt).not.toBeNull();
  });

  it("persists type/score and defaults type to 'event'", async () => {
    const ev = await q.insertFind({ title: "ev", url: "u-ev", agent: "scout" });
    const lead = await q.insertFind({
      title: "lead",
      url: "u-lead",
      agent: "prospector",
      type: "lead",
      score: 0.9,
    });
    const all = await q.getFeed({ view: "all" });
    const evRow = all.find((r) => r.id === ev.id);
    const leadRow = all.find((r) => r.id === lead.id);
    expect(evRow?.type).toBe("event");
    expect(evRow?.placeOsmId).toBeNull();
    expect(leadRow?.type).toBe("lead");
    expect(leadRow?.score).toBe(0.9);
  });

  it("a lead with a new placeOsmId creates the annotation anchor so the FK holds", async () => {
    const r = await q.insertFind({
      title: "Lead Co",
      url: "https://lead.test",
      agent: "prospector",
      type: "lead",
      placeOsmId: "node/424242",
    });
    expect(r.outcome).toBe("created");
    const anchor = await queryOne(
      `SELECT osm_id FROM localfinds.place_annotations WHERE osm_id = $1`,
      ["node/424242"],
    );
    expect(anchor).toBeTruthy();

    const all = await q.getFeed({ view: "all" });
    expect(all.find((f) => f.id === r.id)?.placeOsmId).toBe("node/424242");
  });

  it("is atomic — a failed finds insert rolls back the annotation anchor", async () => {
    // An invalid status trips the finds.status CHECK *after* the place_annotations
    // anchor upsert. With the tx wrapper the whole call rolls back, so no orphan
    // anchor and no find are left behind. (Pre-fix, the anchor would persist.)
    const bad = {
      title: "Atomic",
      url: "https://x.test/atomic",
      agent: "scout",
      placeOsmId: "way/424242",
      status: "not-a-real-status",
    } as unknown as q.NewFindInput;

    await expect(q.insertFind(bad)).rejects.toThrow();

    const anchor = await queryOne<{ osm_id: string }>(
      `SELECT osm_id FROM localfinds.place_annotations WHERE osm_id = $1`,
      ["way/424242"],
    );
    expect(anchor).toBeUndefined();

    const count = await queryOne<{ n: number }>(
      `SELECT count(*)::int AS n FROM localfinds.finds`,
    );
    expect(count?.n).toBe(0);
  });

  it("re-discovery preserves finds.status (never overwrites stars/hides)", async () => {
    const first = await q.insertFind({
      title: "Market",
      url: "https://x.test/market",
      agent: "scout",
    });
    expect(first.outcome).toBe("created");

    // A curator stars it (status lives on finds; feedback is a separate table).
    await execute(`UPDATE localfinds.finds SET status = 'starred' WHERE id = $1`, [first.id]);

    // Re-running an agent re-discovers the same item.
    const again = await q.insertFind({
      title: "Market",
      url: "https://x.test/market",
      agent: "prospector",
    });
    expect(again).toEqual({ outcome: "duplicate", id: first.id });

    const row = await queryOne<{ status: string }>(
      `SELECT status FROM localfinds.finds WHERE id = $1`,
      [first.id],
    );
    expect(row?.status).toBe("starred");
  });
});

describe("getFeed views + filters", () => {
  it("default feed hides hidden + provisional + expired and sorts newest-first", async () => {
    await q.insertFind({ title: "old", url: "u1", agent: "scout" });
    await sleep(2);
    await q.insertFind({ title: "new", url: "u2", agent: "scout" });
    const prov = await q.insertFind({
      title: "prov",
      url: "u3",
      agent: "scout",
      status: "provisional",
    });
    const rows = await q.getFeed();
    expect(rows.map((r) => r.title)).toEqual(["new", "old"]);
    expect(rows.find((r) => r.id === prov.id)).toBeUndefined();
  });

  it("hides expired from default + starred, keeps them in 'all'", async () => {
    const expired = await q.insertFind({
      title: "past",
      url: "u-past",
      expiresAt: "2020-01-01",
      agent: "scout",
    });
    const current = await q.insertFind({
      title: "current",
      url: "u-cur",
      expiresAt: "2999-01-01",
      agent: "scout",
    });
    const undated = await q.insertFind({ title: "undated", url: "u-und", agent: "scout" });

    const def = (await q.getFeed()).map((f) => f.id);
    expect(def).not.toContain(expired.id);
    expect(def).toContain(current.id);
    expect(def).toContain(undated.id);

    const all = (await q.getFeed({ view: "all" })).map((f) => f.id);
    expect(all).toContain(expired.id);
  });

  it("starred view shows only starred, hidden view only hidden", async () => {
    const a = await q.insertFind({ title: "a", url: "ua", agent: "scout" });
    const b = await q.insertFind({ title: "b", url: "ub", agent: "scout" });
    await q.updateFindStatus(a.id, "starred");
    await q.updateFindStatus(b.id, "hidden");
    expect((await q.getFeed({ view: "starred" })).map((f) => f.id)).toEqual([a.id]);
    expect((await q.getFeed({ view: "hidden" })).map((f) => f.id)).toEqual([b.id]);
  });

  it("tag filter uses array membership and listActiveTags unnests", async () => {
    await q.insertFind({ title: "t", url: "u", agent: "scout", tags: ["music", "free"] });
    expect((await q.getFeed({ tag: "music" })).length).toBe(1);
    expect((await q.getFeed({ tag: "nope" })).length).toBe(0);
    expect(await q.listActiveTags()).toEqual(expect.arrayContaining(["music", "free"]));
  });

  it("filters by type and excludeTypes", async () => {
    const ev = await q.insertFind({
      title: "ev",
      url: "u-ev",
      tags: ["tf"],
      agent: "scout",
    });
    const lead = await q.insertFind({
      title: "lead",
      url: "u-lead",
      tags: ["tf"],
      agent: "prospector",
      type: "lead",
    });
    expect((await q.getFeed({ tag: "tf", type: "lead" })).map((f) => f.id)).toEqual([lead.id]);
    const noLead = (await q.getFeed({ tag: "tf", excludeTypes: ["lead"] })).map((f) => f.id);
    expect(noLead).toContain(ev.id);
    expect(noLead).not.toContain(lead.id);
  });

  it("days filter restricts to recently-discovered finds", async () => {
    await q.insertFind({ title: "recent", url: "u-recent", agent: "scout" });
    expect((await q.getFeed({ days: 1 })).length).toBe(1);
    expect((await q.getFeed({ days: 0 })).length).toBe(1); // 0 is falsy -> no day filter
  });
});

describe("getFeedPage", () => {
  it("paginates a tag-scoped set and supports newest/oldest sort", async () => {
    for (const n of ["A", "B", "C", "D", "E"]) {
      await q.insertFind({
        title: `Page ${n}`,
        url: `https://example.com/feedpage-${n}`,
        tags: ["feedpage"],
        agent: "scout",
      });
      await sleep(2); // distinct discovered_at so the order is deterministic
    }

    const all = await q.getFeedPage({ tag: "feedpage" });
    expect(all.rows.map((f) => f.title)).toEqual([
      "Page E",
      "Page D",
      "Page C",
      "Page B",
      "Page A",
    ]);
    expect(all.total).toBe(5);
    expect(all.page).toBe(1);
    expect(all.pageCount).toBe(1);

    const p2 = await q.getFeedPage({ tag: "feedpage", page: 2, pageSize: 2 });
    expect(p2.rows.map((f) => f.title)).toEqual(["Page C", "Page B"]);
    expect(p2.total).toBe(5);
    expect(p2.pageCount).toBe(3);
    expect(p2.page).toBe(2);

    const last = await q.getFeedPage({ tag: "feedpage", page: 99, pageSize: 2 });
    expect(last.page).toBe(3);
    expect(last.rows.map((f) => f.title)).toEqual(["Page A"]);

    const oldest = await q.getFeedPage({ tag: "feedpage", sort: "oldest" });
    expect(oldest.rows.map((f) => f.title)).toEqual([
      "Page A",
      "Page B",
      "Page C",
      "Page D",
      "Page E",
    ]);
  });

  it("sort 'soonest' orders by event start ascending, undated finds last", async () => {
    await q.insertFind({ title: "Soon B", url: "u-b", eventStart: "2026-09-15", tags: ["ss"], agent: "scout" });
    await q.insertFind({ title: "Soon A", url: "u-a", eventStart: "2026-09-01", tags: ["ss"], agent: "scout" });
    await q.insertFind({ title: "Soon Undated", url: "u-u", tags: ["ss"], agent: "scout" });
    await q.insertFind({ title: "Soon C", url: "u-c", eventStart: "2026-09-20T18:00:00Z", tags: ["ss"], agent: "scout" });

    const rows = (await q.getFeedPage({ tag: "ss", sort: "soonest" })).rows.map((f) => f.title);
    expect(rows).toEqual(["Soon A", "Soon B", "Soon C", "Soon Undated"]);
  });

  it("filters by an inclusive event-date range, excluding undated finds", async () => {
    await q.insertFind({ title: "July 10", url: "u-10", eventStart: "2026-07-10", tags: ["er"], agent: "scout" });
    await q.insertFind({ title: "July 15 evening", url: "u-15", eventStart: "2026-07-15T19:00:00Z", tags: ["er"], agent: "scout" });
    await q.insertFind({ title: "July 20", url: "u-20", eventStart: "2026-07-20", tags: ["er"], agent: "scout" });
    await q.insertFind({ title: "Undated", url: "u-und", tags: ["er"], agent: "scout" });

    const inRange = await q.getFeedPage({ tag: "er", from: "2026-07-10", to: "2026-07-15" });
    expect(inRange.rows.map((f) => f.title).sort()).toEqual(["July 10", "July 15 evening"]);

    const endDay = await q.getFeedPage({ tag: "er", from: "2026-07-15", to: "2026-07-15" });
    expect(endDay.rows.map((f) => f.title)).toEqual(["July 15 evening"]);
  });
});

describe("find facets", () => {
  it("listActiveTags / listFindTypes exclude hidden + provisional + expired", async () => {
    await q.insertFind({ title: "vis", url: "u-vis", tags: ["shown-tag"], agent: "scout" });
    await q.insertFind({
      title: "prov",
      url: "u-prov",
      tags: ["prov-tag"],
      type: "lead",
      agent: "prospector",
      status: "provisional",
    });
    const hidden = await q.insertFind({ title: "hid", url: "u-hid", tags: ["hid-tag"], agent: "scout" });
    await q.updateFindStatus(hidden.id, "hidden");

    const tags = await q.listActiveTags();
    expect(tags).toContain("shown-tag");
    expect(tags).not.toContain("prov-tag");
    expect(tags).not.toContain("hid-tag");

    const types = await q.listFindTypes();
    expect(types).toContain("event");
    expect(types).not.toContain("lead"); // only the provisional lead exists
  });
});

describe("provisional finds", () => {
  it("are hidden from views but listable, and promote/discard work", async () => {
    await q.insertFind({ title: "Visible", url: "u-vis", agent: "prospector" });
    await q.insertFind({
      title: "Prov",
      url: "u-prov",
      agent: "prospector",
      status: "provisional",
    });

    expect((await q.getFeed()).map((f) => f.title)).toEqual(["Visible"]);
    expect((await q.listProvisionalFinds()).map((f) => f.title)).toEqual(["Prov"]);

    expect(await q.promoteProvisionalFinds()).toBe(1);
    expect(await q.listProvisionalFinds()).toHaveLength(0);
    expect((await q.getFeed()).map((f) => f.title).sort()).toEqual(["Prov", "Visible"]);

    await q.insertFind({ title: "Prov2", url: "u-prov2", agent: "prospector", status: "provisional" });
    expect(await q.discardProvisionalFinds()).toBe(1);
    expect(await q.listProvisionalFinds()).toHaveLength(0);
  });

  it("listRecentFinds excludes provisional by default, includes them when explicit", async () => {
    const normal = await q.insertFind({ title: "normal", url: "u-n", agent: "prospector", type: "lead" });
    const prov = await q.insertFind({
      title: "prov",
      url: "u-p",
      agent: "prospector",
      type: "lead",
      status: "provisional",
    });

    const def = (await q.listRecentFinds({})).map((f) => f.id);
    expect(def).toContain(normal.id);
    expect(def).not.toContain(prov.id);

    const provOnly = (await q.listRecentFinds({ status: "provisional" })).map((f) => f.id);
    expect(provOnly).toContain(prov.id);
    expect(provOnly).not.toContain(normal.id);
  });
});

describe("status mutations", () => {
  it("markFindsShown flips only 'new' rows to 'shown'", async () => {
    const a = await q.insertFind({ title: "a", url: "ua", agent: "scout" });
    const b = await q.insertFind({ title: "b", url: "ub", agent: "scout" });
    await q.updateFindStatus(b.id, "starred");
    await q.markFindsShown([a.id, b.id]);
    const byId = Object.fromEntries((await q.getFeed({ view: "all" })).map((r) => [r.id, r.status]));
    expect(byId[a.id]).toBe("shown");
    expect(byId[b.id]).toBe("starred"); // not 'new' -> untouched
  });

  it("updateFindStatus returns false for an unknown id", async () => {
    expect(await q.updateFindStatus(999_999, "hidden")).toBe(false);
  });

  it("updateFindStatuses + unhideAll bulk-update and return counts", async () => {
    const a = await q.insertFind({ title: "a", url: "ua", agent: "scout" });
    const b = await q.insertFind({ title: "b", url: "ub", agent: "scout" });
    expect(await q.updateFindStatuses([a.id, b.id], "hidden")).toBe(2);
    expect((await q.getFeed()).length).toBe(0);
    expect(await q.unhideAll()).toBe(2);
    expect((await q.getFeed()).length).toBe(2);
  });

  it("setFindExpiry hides a find once its expiry passes", async () => {
    const a = await q.insertFind({ title: "a", url: "ua", agent: "scout" });
    expect(await q.setFindExpiry(a.id, "2020-01-01")).toBe(true);
    expect((await q.getFeed()).map((r) => r.id)).not.toContain(a.id);
    expect(await q.setFindExpiry(999_999, "2020-01-01")).toBe(false);
  });
});

describe("places", () => {
  it("lists all 7 seeded non-duplicate places", async () => {
    const places = await q.listPlaces({});
    expect(places.length).toBe(7);
    // All in Rockland — verifies the town polygon join fired
    expect(places.every((p) => p.town === "Rockland")).toBe(true);
  });

  it("q search is case-insensitive (ILIKE)", async () => {
    const upper = await q.listPlaces({ q: "COFFEE" });
    const lower = await q.listPlaces({ q: "coffee" });
    expect(lower.length).toBeGreaterThan(0);
    expect(upper.map((p) => p.osmId).sort()).toEqual(lower.map((p) => p.osmId).sort());
  });

  it("town filter restricts to that town", async () => {
    const rockland = await q.listPlaces({ town: "Rockland" });
    expect(rockland.length).toBe(7);
    const none = await q.listPlaces({ town: "Portland" });
    expect(none.length).toBe(0);
  });

  it("status filter honours the annotation override", async () => {
    const { pool } = await import("./client");
    const target = "node/1"; // Rock City Coffee
    await pool().query(
      `INSERT INTO localfinds.place_annotations (osm_id, status_override, added_by)
       VALUES ($1,'closed','test')
       ON CONFLICT (osm_id) DO UPDATE SET status_override='closed'`,
      [target],
    );
    expect((await q.listPlaces({ status: "closed" })).map((p) => p.osmId)).toContain(target);
    expect((await q.listPlaces({ status: "active" })).map((p) => p.osmId)).not.toContain(target);
  });

  it("tags is a key=value string[] derived from jsonb", async () => {
    const p = await q.getPlaceByOsmId("node/1"); // Rock City Coffee — richest tag set
    expect(p).toBeDefined();
    expect(Array.isArray(p!.tags)).toBe(true);
    expect(p!.tags.length).toBeGreaterThan(0);
    // Every tag must match the key=value format (key may contain : for namespaced tags)
    for (const t of p!.tags) {
      expect(t).toMatch(/^[a-z_:]+=/);
    }
    expect(p!.tags).toContain("amenity=cafe");
  });

  it("tag filter matches by OSM key existence (not key=value)", async () => {
    // filters.tag = "amenity" → places that have any amenity tag
    const amenity = await q.listPlaces({ tag: "amenity" });
    expect(amenity.map((p) => p.osmId)).toContain("node/1"); // Rock City Coffee (amenity=cafe)
    expect(amenity.map((p) => p.osmId)).not.toContain("way/2"); // Hannaford (shop, not amenity)

    const shop = await q.listPlaces({ tag: "shop" });
    expect(shop.map((p) => p.osmId)).toContain("way/2"); // Hannaford (shop=supermarket)
    expect(shop.map((p) => p.osmId)).not.toContain("node/1"); // Rock City Coffee (amenity, not shop)
  });

  it("getPlaceByOsmId returns the correct place", async () => {
    const p = await q.getPlaceByOsmId("node/1");
    expect(p).toBeDefined();
    expect(p!.osmId).toBe("node/1");
    expect(p!.name).toBe("Rock City Coffee");
    expect(p!.kind).toBe("amenity=cafe");
    expect(p!.town).toBe("Rockland");
    expect(p!.brand).toBe("Rock City");
  });

  it("getPlaceByOsmId returns undefined for unknown osmId", async () => {
    expect(await q.getPlaceByOsmId("node/999999")).toBeUndefined();
  });

  it("listMapPins rows carry osmId (string), no numeric id", async () => {
    const pins = await q.listMapPins();
    expect(pins.length).toBeGreaterThan(0);
    for (const pin of pins) {
      expect(typeof pin.osmId).toBe("string");
      expect(pin.osmId).toMatch(/^(node|way|relation)\//);
      expect((pin as unknown as Record<string, unknown>).id).toBeUndefined();
    }
  });

  it("duplicate_of rows hidden by default, shown with includeDuplicates", async () => {
    const { pool } = await import("./client");
    // Manually mark node/1 as a duplicate of way/2
    await pool().query(
      `INSERT INTO localfinds.place_annotations (osm_id, duplicate_of, added_by)
       VALUES ('node/1','way/2','test')
       ON CONFLICT (osm_id) DO UPDATE SET duplicate_of='way/2'`,
    );
    const withoutDups = await q.listPlaces({});
    expect(withoutDups.map((p) => p.osmId)).not.toContain("node/1");
    expect(withoutDups.length).toBe(6); // 7 − 1 duplicate

    const withDups = await q.listPlaces({ includeDuplicates: true });
    const dup = withDups.find((p) => p.osmId === "node/1");
    expect(dup).toBeDefined();
    expect(dup!.duplicateOf).toBe("way/2");
  });

  it("countPlaces excludes duplicate-marked rows", async () => {
    expect(await q.countPlaces()).toBe(7);
    const { pool } = await import("./client");
    await pool().query(
      `INSERT INTO localfinds.place_annotations (osm_id, duplicate_of, added_by)
       VALUES ('node/1','way/2','test')
       ON CONFLICT (osm_id) DO UPDATE SET duplicate_of='way/2'`,
    );
    expect(await q.countPlaces()).toBe(6);
  });

  it("listPlaceTowns returns town + count, excluding duplicates", async () => {
    const towns = await q.listPlaceTowns();
    const rockland = towns.find((t) => t.town === "Rockland");
    expect(rockland).toBeDefined();
    expect(rockland!.n).toBe(7);
  });

  it("dedupePlaces marks a near-duplicate pair (groups:1 marked:1)", async () => {
    const { pool } = await import("./client");
    // Insert a near-duplicate of Rock City Coffee (node/1, lat≈44.10, lng≈-69.11).
    // node/999 has the same name + is ~3 m away — well within DUP_RADIUS_M=50.
    await pool().query(`
      INSERT INTO planet_osm_point (osm_id, tags, way) VALUES
      (999, hstore(ARRAY['amenity','name'], ARRAY['cafe','Rock City Coffee']),
       ST_Transform(ST_SetSRID(ST_MakePoint(-69.10995, 44.10), 4326), 3857))
    `);
    await pool().query(`REFRESH MATERIALIZED VIEW CONCURRENTLY public.osm_places`);
    try {
      const result = await q.dedupePlaces();
      expect(result.groups).toBe(1);
      expect(result.marked).toBe(1);
      // The loser (less-rich node/999) should have duplicate_of set
      const { queryOne } = await import("./client");
      const ann = await queryOne<{ duplicate_of: string }>(
        `SELECT duplicate_of FROM localfinds.place_annotations WHERE osm_id = 'node/999'`,
      );
      expect(ann?.duplicate_of).toBe("node/1");
    } finally {
      await pool().query(`DELETE FROM planet_osm_point WHERE osm_id = 999`);
      await pool().query(`REFRESH MATERIALIZED VIEW CONCURRENTLY public.osm_places`);
    }
  });
});

describe("feedback", () => {
  it("records feedback and round-trips it via readFeedbackForAgent", async () => {
    const find = await q.insertFind({
      title: "Feedback target",
      url: "u-fb",
      agent: "cursor-test",
      tags: ["fb"],
    });
    await q.recordFeedback(find.id, "thumbs_up", "nice");
    const rows = await q.readFeedbackForAgent("cursor-test");
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      action: "thumbs_up",
      note: "nice",
      findId: find.id,
      findTitle: "Feedback target",
      foundBy: "cursor-test",
    });
    expect(rows[0].findTags).toEqual(["fb"]);
  });

  it("returns only feedback newer than the agent's last successful run", async () => {
    const find = await q.insertFind({ title: "t", url: "u-fb2", agent: "cursor-test" });
    await q.recordFeedback(find.id, "thumbs_up");
    await sleep(5);

    // No successful run yet -> everything is unread.
    expect((await q.readFeedbackForAgent("cursor-test")).length).toBe(1);

    const runId = await q.startRun("cursor-test");
    await q.finishRun(runId, { status: "success" });
    await sleep(5);

    // Old feedback predates the run cursor.
    expect((await q.readFeedbackForAgent("cursor-test")).length).toBe(0);

    await q.recordFeedback(find.id, "star");
    const unread = await q.readFeedbackForAgent("cursor-test");
    expect(unread.length).toBe(1);
    expect(unread[0].action).toBe("star");
  });

  it("a failed run does not advance the cursor", async () => {
    const find = await q.insertFind({ title: "t", url: "u-fb3", agent: "cursor-test-2" });
    await q.recordFeedback(find.id, "hide");
    await sleep(5);
    const runId = await q.startRun("cursor-test-2");
    await q.finishRun(runId, { status: "error", error: "boom" });
    const unread = await q.readFeedbackForAgent("cursor-test-2");
    expect(unread.some((r) => r.findId === find.id && r.action === "hide")).toBe(true);
  });
});

describe("sources", () => {
  it("upsertSource creates a new source and reports created", async () => {
    const { id, outcome } = await q.upsertSource({ url: "https://a.test", name: "A", addedBy: "test" });
    expect(outcome).toBe("created");
    expect(id).toBeGreaterThan(0);
    const src = await q.getSourceById(id);
    expect(src?.url).toBe("https://a.test");
    expect(src?.name).toBe("A");
    expect(src?.lastCheckedAt).not.toBeNull();
  });

  it("upsertSource reports updated + updates name on second call", async () => {
    const first = await q.upsertSource({ url: "https://b.test", name: "B", addedBy: "test" });
    const second = await q.upsertSource({ url: "https://b.test", name: "B updated", addedBy: "test" });
    expect(second.outcome).toBe("updated");
    expect(second.id).toBe(first.id);
    const after = await q.getSourceById(second.id);
    expect(after?.name).toBe("B updated");
  });

  it("listSources returns all rows ordered by url", async () => {
    await q.upsertSource({ url: "https://z.test", name: "Z", addedBy: "test" });
    await q.upsertSource({ url: "https://a.test", name: "A", addedBy: "test" });
    await q.upsertSource({ url: "https://m.test", name: "M", addedBy: "test" });
    const sources = await q.listSources();
    const urls = sources.map((s) => s.url);
    expect(urls).toEqual([...urls].sort());
    expect(urls).toContain("https://a.test");
    expect(urls).toContain("https://m.test");
    expect(urls).toContain("https://z.test");
  });

  it("getSourceById returns undefined for unknown id", async () => {
    expect(await q.getSourceById(999_999)).toBeUndefined();
  });

  it("listFindsBySource returns finds linked to a source newest-first", async () => {
    const { id: sourceId } = await q.upsertSource({ url: "https://src2.test", name: "Src2", addedBy: "test" });
    const f1 = await q.insertFind({ title: "F1", url: "https://src2.test/1", agent: "scout", sourceUrl: "https://src2.test" });
    await sleep(5);
    const f2 = await q.insertFind({ title: "F2", url: "https://src2.test/2", agent: "scout", sourceUrl: "https://src2.test" });
    const rows = await q.listFindsBySource(sourceId);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(f1.id);
    expect(ids).toContain(f2.id);
    // newest-first: f2 discovered after f1
    expect(ids.indexOf(f2.id)).toBeLessThan(ids.indexOf(f1.id));
  });
});

describe("runs + fetches", () => {
  it("startRun/finishRun round-trip with usageJson serialised through jsonb", async () => {
    const id = await q.startRun("scout");
    expect(id).toBeGreaterThan(0);
    const usageJson = JSON.stringify({ input: 100, output: 200 });
    await q.finishRun(id, {
      status: "success",
      costUsd: 0.42,
      usageJson,
      numTurns: 5,
      itemsAdded: 3,
      itemsUpdated: 1,
      sessionId: "sess-abc",
    });
    const run = await q.getRun(id);
    expect(run).toBeDefined();
    expect(run!.agent).toBe("scout");
    expect(run!.status).toBe("success");
    expect(run!.costUsd).toBeCloseTo(0.42);
    expect(run!.numTurns).toBe(5);
    expect(run!.itemsAdded).toBe(3);
    expect(run!.itemsUpdated).toBe(1);
    expect(run!.sessionId).toBe("sess-abc");
    // usageJson round-trips: stored as jsonb, read back as text
    expect(JSON.parse(run!.usageJson!)).toEqual({ input: 100, output: 200 });
    expect(run!.finishedAt).not.toBeNull();
  });

  it("finishRun sets status + cost; costLastNDays sums", async () => {
    const id = await q.startRun("scout");
    await q.finishRun(id, { status: "success", costUsd: 0.5, usageJson: JSON.stringify({ a: 1 }) });
    expect(await q.costLastNDays(1)).toBeCloseTo(0.5);
  });

  it("costLastNDays returns 0 when no runs have costs", async () => {
    expect(await q.costLastNDays(1)).toBe(0);
  });

  it("costLastNDays sums multiple runs", async () => {
    const r1 = await q.startRun("scout");
    const r2 = await q.startRun("scout");
    await q.finishRun(r1, { status: "success", costUsd: 0.3 });
    await q.finishRun(r2, { status: "success", costUsd: 0.2 });
    expect(await q.costLastNDays(1)).toBeCloseTo(0.5);
  });

  it("listRuns returns runs newest-first", async () => {
    const r1 = await q.startRun("scout");
    await sleep(5);
    const r2 = await q.startRun("scout");
    const runs = await q.listRuns();
    const ids = runs.map((r) => r.id);
    expect(ids.indexOf(r2)).toBeLessThan(ids.indexOf(r1));
  });

  it("blockedHosts flags a host after 3 consecutive blocks, reset by a non-block", async () => {
    const run = await q.startRun("scout");
    for (let i = 0; i < 3; i++)
      await q.recordFetch({ runId: run, agent: "scout", host: "x.test", url: "u", status: 403, klass: "blocked" });
    expect(await q.blockedHosts()).toContain("x.test");
    await q.recordFetch({ runId: run, agent: "scout", host: "x.test", url: "u", status: 200, klass: "ok" });
    expect(await q.blockedHosts()).not.toContain("x.test");
  });

  it("blockedHosts does not flag a host with fewer than 3 consecutive blocks", async () => {
    const run = await q.startRun("scout");
    await q.recordFetch({ runId: run, agent: "scout", host: "y.test", url: "u", status: 403, klass: "blocked" });
    await q.recordFetch({ runId: run, agent: "scout", host: "y.test", url: "u", status: 403, klass: "blocked" });
    expect(await q.blockedHosts()).not.toContain("y.test");
  });

  it("recordFetch + listFetchesForHost + clearFetchHistory", async () => {
    const run = await q.startRun("scout");
    await q.recordFetch({ runId: run, agent: "scout", host: "foo.test", url: "https://foo.test/a", status: 200, klass: "ok" });
    await q.recordFetch({ runId: run, agent: "scout", host: "foo.test", url: "https://foo.test/b", status: 403, klass: "blocked" });
    const fetches = await q.listFetchesForHost("foo.test");
    expect(fetches.length).toBe(2);
    expect(fetches[0].url).toBe("https://foo.test/a");
    expect(fetches[1].url).toBe("https://foo.test/b");
    expect(fetches[0].klass).toBe("ok");
    expect(fetches[1].klass).toBe("blocked");
    const cleared = await q.clearFetchHistory("foo.test");
    expect(cleared).toBe(2);
    expect((await q.listFetchesForHost("foo.test")).length).toBe(0);
  });
});
