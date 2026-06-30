import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { resetDb, setupPgDatabase, teardownPgDatabase } from "../test/harness";
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
    const { queryOne } = await import("./client");
    const anchor = await queryOne(
      `SELECT osm_id FROM localfinds.place_annotations WHERE osm_id = $1`,
      ["node/424242"],
    );
    expect(anchor).toBeTruthy();

    const all = await q.getFeed({ view: "all" });
    expect(all.find((f) => f.id === r.id)?.placeOsmId).toBe("node/424242");
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
