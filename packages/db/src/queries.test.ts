import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// Point the whole db package at a throwaway data dir BEFORE importing it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "localfinds-test-"));
process.env.LOCALFINDS_DATA_DIR = tmp;

let q: typeof import("./queries");
let cfg: typeof import("./config");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  execSync("npx drizzle-kit push --force", {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...process.env, LOCALFINDS_DATA_DIR: tmp },
    stdio: "ignore",
  });
  q = await import("./queries");
  cfg = await import("./config");
}, 60_000);

describe("insertFind dedupe", () => {
  it("dedupes url variants of the same item", () => {
    const first = q.insertFind({
      title: "Concert at the park",
      url: "https://www.example.com/concert/?utm_source=newsletter",
      agent: "test",
    });
    expect(first.outcome).toBe("created");

    const second = q.insertFind({
      title: "Concert at the park",
      url: "http://example.com/concert",
      agent: "test",
    });
    expect(second).toEqual({ outcome: "duplicate", id: first.id });
  });

  it("keeps distinct events that share one listing URL", () => {
    const ecologyWalk = q.insertFind({
      title: "Free Family Fridays: Summer Ecology Walk",
      url: "https://merryspring.org/calendar/",
      agent: "test",
    });
    const roseDay = q.insertFind({
      title: "Merryspring Rose Day: Lecture & Garden Walk",
      url: "https://merryspring.org/calendar/",
      agent: "test",
    });
    expect(ecologyWalk.outcome).toBe("created");
    expect(roseDay.outcome).toBe("created");
    expect(roseDay.id).not.toBe(ecologyWalk.id);
  });
});

describe("feed expiry filtering", () => {
  it("hides expired items from default and starred views, keeps them in 'all'", () => {
    const expired = q.insertFind({
      title: "Past event",
      url: "https://example.com/past",
      expiresAt: "2020-01-01",
      agent: "test",
    });
    const current = q.insertFind({
      title: "Current event",
      url: "https://example.com/current",
      expiresAt: "2999-01-01",
      agent: "test",
    });
    const undated = q.insertFind({
      title: "Undated item",
      url: "https://example.com/undated",
      agent: "test",
    });

    const defaultIds = q.getFeed().map((f) => f.id);
    expect(defaultIds).not.toContain(expired.id);
    expect(defaultIds).toContain(current.id);
    expect(defaultIds).toContain(undated.id);

    const allIds = q.getFeed({ view: "all" }).map((f) => f.id);
    expect(allIds).toContain(expired.id);
  });

  it("filters by tag", () => {
    const tagged = q.insertFind({
      title: "Tagged item",
      url: "https://example.com/tagged",
      tags: ["music", "free"],
      agent: "test",
    });
    const ids = q.getFeed({ tag: "music" }).map((f) => f.id);
    expect(ids).toContain(tagged.id);
    expect(q.getFeed({ tag: "nope" })).toHaveLength(0);
  });
});

describe("businesses", () => {
  it("creates then updates on the same osmId without nulling omitted fields", async () => {
    const created = q.upsertBusiness({
      osmId: "node/1",
      name: "Rock City Coffee",
      kind: "amenity=cafe",
      tags: ["cafe", "coffee"],
      address: "316 Main St, Rockland",
      town: "Rockland",
      website: "https://rockcitycoffee.com",
      phone: "207-555-0100",
      addedBy: "test",
    });
    expect(created.outcome).toBe("created");

    const before = q.listBusinesses({ q: "Rock City" })[0];
    await sleep(5);

    // A sparse re-scan that only re-confirms name/town must not wipe phone/website.
    const updated = q.upsertBusiness({
      osmId: "node/1",
      name: "Rock City Coffee",
      town: "Rockland",
      addedBy: "test",
    });
    expect(updated).toEqual({ id: created.id, outcome: "updated" });

    const after = q.listBusinesses({ q: "Rock City" })[0];
    expect(after.phone).toBe("207-555-0100");
    expect(after.website).toBe("https://rockcitycoffee.com");
    expect(after.discoveredAt).toBe(before.discoveredAt);
    expect(after.lastSeenAt > before.lastSeenAt).toBe(true);
  });

  it("filters by town, tag, status, and name substring", () => {
    q.upsertBusiness({
      osmId: "way/10",
      name: "Camden Hardware",
      tags: ["hardware", "doityourself"],
      town: "Camden",
      status: "active",
      addedBy: "test",
    });
    q.upsertBusiness({
      osmId: "way/11",
      name: "Closed Diner",
      tags: ["restaurant"],
      town: "Camden",
      status: "closed",
      addedBy: "test",
    });

    expect(q.listBusinesses({ town: "Camden" }).map((b) => b.osmId).sort()).toEqual([
      "way/10",
      "way/11",
    ]);
    expect(q.listBusinesses({ tag: "hardware" }).map((b) => b.osmId)).toEqual(["way/10"]);
    expect(q.listBusinesses({ status: "closed" }).map((b) => b.osmId)).toEqual(["way/11"]);
    expect(q.listBusinesses({ q: "hardware" }).map((b) => b.osmId)).toEqual(["way/10"]);
    expect(q.listBusinesses({ town: "Nowhere" })).toHaveLength(0);
  });

  it("stores and returns the brand (chain signal)", () => {
    q.upsertBusiness({
      osmId: "node/200",
      name: "Hannaford",
      kind: "shop=supermarket",
      brand: "Hannaford",
      town: "Rockland",
      addedBy: "test",
    });
    const b = q.listBusinesses({ q: "Hannaford" })[0];
    expect(b.brand).toBe("Hannaford");
  });

  it("filters to rows with a non-empty website when hasWebsite is set", () => {
    q.upsertBusiness({
      osmId: "node/w1",
      name: "Has Website",
      town: "WebFilter",
      website: "https://has-site.example.com",
      addedBy: "test",
    });
    q.upsertBusiness({
      osmId: "node/w2",
      name: "No Website",
      town: "WebFilter",
      addedBy: "test",
    });
    q.upsertBusiness({
      osmId: "node/w3",
      name: "Empty Website",
      town: "WebFilter",
      website: "",
      addedBy: "test",
    });

    // Without the filter, all three are returned.
    expect(
      q.listBusinesses({ town: "WebFilter" }).map((b) => b.osmId).sort(),
    ).toEqual(["node/w1", "node/w2", "node/w3"]);

    // With it, only the row that actually has a website (null and "" excluded).
    expect(
      q.listBusinesses({ town: "WebFilter", hasWebsite: true }).map((b) => b.osmId),
    ).toEqual(["node/w1"]);
  });

  it("lists distinct towns with counts, alphabetically, excluding null towns", () => {
    q.upsertBusiness({ osmId: "node/100", name: "A", town: "Owls Head", addedBy: "test" });
    q.upsertBusiness({ osmId: "node/101", name: "B", town: "Owls Head", addedBy: "test" });
    q.upsertBusiness({ osmId: "node/102", name: "C", town: "Vinalhaven", addedBy: "test" });
    q.upsertBusiness({ osmId: "node/103", name: "D", addedBy: "test" }); // no town

    const towns = q.listBusinessTowns();
    expect(towns).toContainEqual({ town: "Owls Head", n: 2 });
    expect(towns).toContainEqual({ town: "Vinalhaven", n: 1 });
    expect(towns.some((t) => t.town === null)).toBe(false);
    const names = towns.map((t) => t.town);
    expect(names).toEqual([...names].sort());
  });
});

describe("upsertSource", () => {
  it("reports created for a new URL and updated for an existing one", () => {
    const first = q.upsertSource({
      url: "https://src-outcome.example.com",
      name: "Source",
      addedBy: "test",
    });
    expect(first.outcome).toBe("created");

    const second = q.upsertSource({
      url: "https://src-outcome.example.com",
      name: "Source renamed",
      addedBy: "test",
    });
    expect(second).toEqual({ id: first.id, outcome: "updated" });
  });
});

describe("category priorities", () => {
  it("maps categories to tiers, honoring wildcards and the default", () => {
    const cfgDir = path.join(tmp, "config");
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(
      path.join(cfgDir, "categories.json"),
      JSON.stringify({
        default_tier: 3,
        tiers: {
          "1": ["amenity=townhall"],
          "2": ["craft=*"],
          "4": ["amenity=parking"],
        },
      }),
    );
    const c = cfg.readCategoryConfig();
    expect(c.tierOf("amenity=townhall")).toBe(1); // exact
    expect(c.tierOf("craft=boatbuilder")).toBe(2); // wildcard key=*
    expect(c.tierOf("amenity=parking")).toBe(4); // excluded
    expect(c.tierOf("shop=anything")).toBe(3); // default
    expect(c.tierOf(null)).toBe(3); // no kind
  });
});

describe("feedback cursor", () => {
  it("returns only feedback newer than the agent's last successful run", async () => {
    const find = q.insertFind({
      title: "Feedback target",
      url: "https://example.com/feedback-target",
      agent: "cursor-test",
    });

    q.recordFeedback(find.id, "thumbs_up");
    await sleep(5);

    // No successful run yet → everything is unread
    expect(q.readFeedbackForAgent("cursor-test").length).toBe(1);

    const runId = q.startRun("cursor-test");
    q.finishRun(runId, { status: "success" });
    await sleep(5);

    // Old feedback predates the run cursor
    expect(q.readFeedbackForAgent("cursor-test").length).toBe(0);

    q.recordFeedback(find.id, "star");
    const unread = q.readFeedbackForAgent("cursor-test");
    expect(unread.length).toBe(1);
    expect(unread[0].action).toBe("star");
    expect(unread[0].findTitle).toBe("Feedback target");
  });

  it("failed runs do not advance the cursor", async () => {
    const find = q.insertFind({
      title: "Cursor failure case",
      url: "https://example.com/cursor-failure",
      agent: "cursor-test-2",
    });
    q.recordFeedback(find.id, "hide");
    await sleep(5);

    const runId = q.startRun("cursor-test-2");
    q.finishRun(runId, { status: "error", error: "boom" });

    // Feedback is global by design; the point here is that the failed run
    // did not advance this agent's cursor past the pre-run 'hide'.
    const unread = q.readFeedbackForAgent("cursor-test-2");
    expect(
      unread.some((r) => r.findId === find.id && r.action === "hide"),
    ).toBe(true);
  });
});

describe("category config fallback", () => {
  const cfgDir = path.join(tmp, "config");
  const live = path.join(cfgDir, "categories.json");
  const example = path.join(cfgDir, "categories.json.example");

  it("falls back to the .example template when categories.json is present but malformed", () => {
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(live, "{ not valid json,, ");
    fs.writeFileSync(
      example,
      JSON.stringify({ default_tier: 3, tiers: { "1": ["amenity=library"] } }),
    );

    const c = cfg.readCategoryConfig();
    // The real tier from the template must survive, not collapse to default.
    expect(c.tierOf("amenity=library")).toBe(1);

    fs.rmSync(live);
    fs.rmSync(example);
  });

  it("coerces a non-numeric default_tier to a finite number instead of NaN", () => {
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(live, JSON.stringify({ default_tier: "oops", tiers: {} }));

    const c = cfg.readCategoryConfig();
    expect(Number.isFinite(c.tierOf("shop=whatever"))).toBe(true);

    fs.rmSync(live);
  });
});

describe("listBusinesses name search escaping", () => {
  it("treats % and _ in the query as literal characters, not SQL wildcards", () => {
    q.upsertBusiness({ osmId: "node/900", name: "50% Off Outlet", town: "Esc", addedBy: "test" });
    q.upsertBusiness({ osmId: "node/901", name: "5000 Club", town: "Esc", addedBy: "test" });
    q.upsertBusiness({ osmId: "node/902", name: "a_b shop", town: "Esc", addedBy: "test" });
    q.upsertBusiness({ osmId: "node/903", name: "axb shop", town: "Esc", addedBy: "test" });

    // '%' is literal: matches "50% Off Outlet", NOT "5000 Club"
    expect(q.listBusinesses({ q: "50%" }).map((b) => b.osmId)).toEqual(["node/900"]);
    // '_' is literal: matches "a_b shop", NOT "axb shop"
    expect(q.listBusinesses({ q: "a_b" }).map((b) => b.osmId)).toEqual(["node/902"]);
  });
});

describe("readAgentNote", () => {
  it("reads a note inside the workspace but refuses paths that escape it", async () => {
    const { readAgentNote } = await import("./paths");
    const dir = path.join(tmp, "agents", "cartographer", "notes");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "rockland.md"), "# Rockland note");

    expect(readAgentNote("cartographer", "notes/rockland.md")).toBe("# Rockland note");
    expect(readAgentNote("cartographer", "../../../etc/passwd")).toBeNull();
    expect(readAgentNote("cartographer", null)).toBeNull();
  });
});

describe("listBusinessesRanked", () => {
  it("annotates tier + isChain, hides tier4/chains by default, and ranks chains last", () => {
    const cfgDir = path.join(tmp, "config");
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(
      path.join(cfgDir, "categories.json"),
      JSON.stringify({
        default_tier: 3,
        hide_in_directory: { tier4: true, chains: true },
        tiers: {
          "1": ["amenity=library"],
          "2": ["shop=hardware"],
          "4": ["amenity=parking"],
        },
      }),
    );
    q.upsertBusiness({ osmId: "node/r1", name: "Library", kind: "amenity=library", town: "Rank", addedBy: "test" });
    q.upsertBusiness({ osmId: "node/r2", name: "Hardware", kind: "shop=hardware", town: "Rank", addedBy: "test" });
    q.upsertBusiness({ osmId: "node/r3", name: "Parking Lot", kind: "amenity=parking", town: "Rank", addedBy: "test" });
    q.upsertBusiness({ osmId: "node/r4", name: "Chain Store", kind: "shop=hardware", brand: "BigCo", town: "Rank", addedBy: "test" });

    const def = q.listBusinessesRanked({ town: "Rank" });
    const byId = Object.fromEntries(def.rows.map((r) => [r.business.osmId, r]));
    expect(byId["node/r1"].tier).toBe(1);
    // default visibility: tier4 (parking) and chains hidden
    expect(def.rows.map((r) => r.business.osmId)).toEqual(["node/r1", "node/r2"]);
    expect(def.total).toBe(4);
    expect(def.tier4Count).toBe(1);
    expect(def.chainCount).toBe(1);

    // agent-style: Tier 1-2 only, no chains
    const t12 = q.listBusinessesRanked({ town: "Rank", maxTier: 2, includeChains: false });
    expect(t12.rows.map((r) => r.business.osmId)).toEqual(["node/r1", "node/r2"]);

    // show everything: non-chains first (by tier), chain last
    const full = q.listBusinessesRanked({
      town: "Rank",
      includeTier4: true,
      includeChains: true,
    });
    expect(full.rows.map((r) => r.business.osmId)).toEqual([
      "node/r1",
      "node/r2",
      "node/r3",
      "node/r4",
    ]);
    const fullById = Object.fromEntries(
      full.rows.map((r) => [r.business.osmId, r]),
    );
    expect(fullById["node/r4"].isChain).toBe(true);
    expect(fullById["node/r3"].tier).toBe(4);
  });
});

describe("dedupeBusinesses", () => {
  it("collapses same-name same-coord OSM elements into one canonical row", () => {
    const a = q.upsertBusiness({
      osmId: "way/900001",
      name: "Dedup Test Cafe",
      lat: 44.2,
      lng: -69.2,
      website: "https://dedup-a.example.com",
      addedBy: "test",
    });
    const b = q.upsertBusiness({
      osmId: "way/900002",
      name: "Dedup Test Cafe",
      lat: 44.2,
      lng: -69.2,
      phone: "207-555-0101",
      addedBy: "test",
    });
    expect(a.outcome).toBe("created");
    expect(b.outcome).toBe("created");

    const summary = q.dedupeBusinesses();
    expect(summary.groups).toBeGreaterThanOrEqual(1);

    // Default view hides the duplicate and keeps one canonical row.
    const visible = q.listBusinesses({ q: "Dedup Test Cafe" });
    expect(visible).toHaveLength(1);
    const canonical = visible[0];
    expect(canonical.osmId).toBe("way/900001"); // older row wins the richness tie
    expect(canonical.website).toBe("https://dedup-a.example.com");
    expect(canonical.phone).toBe("207-555-0101"); // merged up from the duplicate

    // includeDuplicates shows both; the loser points at the canonical osm_id.
    const all = q.listBusinesses({
      q: "Dedup Test Cafe",
      includeDuplicates: true,
    });
    expect(all).toHaveLength(2);
    const dup = all.find((r) => r.osmId === "way/900002");
    expect(dup?.duplicateOf).toBe("way/900001");
  });
});

describe("listMapPins / countBusinesses", () => {
  it("returns only coordinate-bearing, non-duplicate rows, annotated", () => {
    q.upsertBusiness({ osmId: "node/9001", name: "Has Coords", kind: "amenity=cafe",
      town: "Rockland", lat: 44.1, lng: -69.11, addedBy: "test" });
    q.upsertBusiness({ osmId: "node/9002", name: "No Coords", kind: "amenity=cafe",
      town: "Rockland", addedBy: "test" }); // lat/lng null -> excluded from pins
    q.upsertBusiness({ osmId: "node/9003", name: "Chain", kind: "shop=supermarket",
      town: "Rockland", lat: 44.2, lng: -69.2, brand: "Hannaford", addedBy: "test" });

    const pins = q.listMapPins();
    const byName = Object.fromEntries(pins.map((p) => [p.name, p]));
    expect(byName["No Coords"]).toBeUndefined();        // no coords -> not a pin
    expect(byName["Has Coords"]).toMatchObject({
      kind: "amenity=cafe", lat: 44.1, lng: -69.11, isChain: false,
      theme: "other", subtype: null, subtypeKey: null,
    });
    expect(typeof byName["Has Coords"].tier).toBe("number");
    expect(byName["Chain"].isChain).toBe(true);          // brand present
  });

  it("countBusinesses counts non-duplicate rows including coordinate-less ones", () => {
    const total = q.countBusinesses();
    const pins = q.listMapPins().length;
    expect(pins).toBeGreaterThanOrEqual(2); // "Has Coords" + "Chain" from the previous test
    expect(total).toBeGreaterThan(pins);    // "No Coords" is counted but not pinned
  });

  it("returns all rows with no cap (regression: the old 500-row limit dropped towns)", () => {
    for (let i = 0; i < 600; i++) {
      q.upsertBusiness({
        osmId: `node/7${i}`, name: `Bulk ${i}`, kind: "amenity=cafe", town: "Bulkville",
        lat: 44 + i / 100000, lng: -69 - i / 100000, addedBy: "test",
      });
    }
    const bulk = q.listMapPins().filter((p) => p.town === "Bulkville");
    expect(bulk.length).toBe(600); // capped at 500 under the old listBusinesses() path
  });
});

describe("listBusinessesRanked pagination", () => {
  it("returns only the requested page plus matched/pageCount, full set when unpaged", () => {
    const cfgDir = path.join(tmp, "config");
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(
      path.join(cfgDir, "categories.json"),
      JSON.stringify({
        default_tier: 3,
        hide_in_directory: { tier4: false, chains: false },
        tiers: {},
      }),
    );
    for (const n of ["A", "B", "C", "D", "E"]) {
      q.upsertBusiness({
        osmId: `node/pg-${n}`,
        name: `Pager ${n}`,
        town: "Pager",
        addedBy: "test",
      });
    }

    // Unpaged (no pageSize): the full sorted set, page/pageCount default to 1.
    const all = q.listBusinessesRanked({ town: "Pager" });
    expect(all.rows.map((r) => r.business.name)).toEqual([
      "Pager A",
      "Pager B",
      "Pager C",
      "Pager D",
      "Pager E",
    ]);
    expect(all.total).toBe(5);
    expect(all.matched).toBe(5);
    expect(all.page).toBe(1);
    expect(all.pageCount).toBe(1);

    // Page 2 of size 2 -> third + fourth rows; matched/pageCount span the full set.
    const p2 = q.listBusinessesRanked({ town: "Pager", page: 2, pageSize: 2 });
    expect(p2.rows.map((r) => r.business.name)).toEqual(["Pager C", "Pager D"]);
    expect(p2.matched).toBe(5);
    expect(p2.pageCount).toBe(3);
    expect(p2.page).toBe(2);

    // Out-of-range page clamps to the last (partial) page.
    const last = q.listBusinessesRanked({ town: "Pager", page: 99, pageSize: 2 });
    expect(last.page).toBe(3);
    expect(last.rows.map((r) => r.business.name)).toEqual(["Pager E"]);
  });
});

describe("getSourceById / listFindsBySource", () => {
  it("returns a source by id, or undefined for an unknown id", () => {
    const { id } = q.upsertSource({
      url: "https://t1-library.example.org",
      name: "T1 Library",
      addedBy: "test",
    });
    const found = q.getSourceById(id);
    expect(found?.id).toBe(id);
    expect(found?.name).toBe("T1 Library");
    expect(q.getSourceById(999_999)).toBeUndefined();
  });

  it("lists a source's finds newest-first, capped by limit", async () => {
    const url = "https://t1-news.example.org";
    const { id: sourceId } = q.upsertSource({ url, name: "T1 News", addedBy: "test" });

    const older = q.insertFind({ title: "T1 older", url: `${url}/a`, agent: "test", sourceUrl: url });
    await sleep(5);
    const newer = q.insertFind({ title: "T1 newer", url: `${url}/b`, agent: "test", sourceUrl: url });

    const rows = q.listFindsBySource(sourceId);
    expect(rows.map((f) => f.id)).toEqual([newer.id, older.id]);

    const capped = q.listFindsBySource(sourceId, 1);
    expect(capped.map((f) => f.id)).toEqual([newer.id]);
  });
});
