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
      title: "Concert at the park (reworded)",
      url: "http://example.com/concert",
      agent: "test",
    });
    expect(second).toEqual({ outcome: "duplicate", id: first.id });
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
