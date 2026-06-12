import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// Point the whole db package at a throwaway data dir BEFORE importing it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "localfinds-test-"));
process.env.LOCALFINDS_DATA_DIR = tmp;

let q: typeof import("./queries");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  execSync("npx drizzle-kit push --force", {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...process.env, LOCALFINDS_DATA_DIR: tmp },
    stdio: "ignore",
  });
  q = await import("./queries");
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
