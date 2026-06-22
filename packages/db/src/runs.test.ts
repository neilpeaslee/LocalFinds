import { describe, expect, it } from "vitest";
import type { Run } from "./schema";
import {
  RUN_STALE_MS,
  RUN_TARGETS,
  isRunStale,
  resolveTarget,
  runInProgress,
} from "./runs";

const NOW = Date.parse("2026-06-14T12:00:00.000Z");

function makeRun(partial: Partial<Run>): Run {
  return {
    id: 1,
    agent: "scout",
    startedAt: new Date(NOW).toISOString(),
    finishedAt: null,
    status: "running",
    itemsAdded: 0,
    itemsUpdated: 0,
    warnings: 0,
    numTurns: null,
    costUsd: null,
    usageJson: null,
    sessionId: null,
    error: null,
    ...partial,
  };
}

describe("resolveTarget", () => {
  it("accepts every valid target unchanged", () => {
    for (const target of RUN_TARGETS) {
      expect(resolveTarget(target)).toBe(target);
    }
  });

  it("includes the five roster agents and 'all'", () => {
    expect([...RUN_TARGETS].sort()).toEqual(
      ["all", "cartographer", "curator", "prospector", "scout", "source-keeper"].sort(),
    );
  });

  it("rejects unknown targets", () => {
    expect(resolveTarget("bogus")).toBeNull();
    expect(resolveTarget("")).toBeNull();
  });

  it("rejects injection-shaped input", () => {
    expect(resolveTarget("scout; rm -rf /")).toBeNull();
    expect(resolveTarget("all && curl evil")).toBeNull();
  });
});

describe("runInProgress", () => {
  it("returns false for an empty list", () => {
    expect(runInProgress([], NOW)).toBe(false);
  });

  it("returns true for a running row started within the window", () => {
    const run = makeRun({ startedAt: new Date(NOW - 60_000).toISOString() });
    expect(runInProgress([run], NOW)).toBe(true);
  });

  it("returns false when the only running row is stale", () => {
    const run = makeRun({
      startedAt: new Date(NOW - RUN_STALE_MS - 1).toISOString(),
    });
    expect(runInProgress([run], NOW)).toBe(false);
  });

  it("returns false when every row is terminal", () => {
    const runs = [
      makeRun({ status: "success" }),
      makeRun({ status: "error" }),
    ];
    expect(runInProgress(runs, NOW)).toBe(false);
  });

  it("returns true for a live running row among terminal rows", () => {
    const runs = [
      makeRun({ status: "success" }),
      makeRun({ startedAt: new Date(NOW - 5_000).toISOString() }),
    ];
    expect(runInProgress(runs, NOW)).toBe(true);
  });
});

describe("isRunStale", () => {
  it("is false for a running row within the window", () => {
    const run = makeRun({ startedAt: new Date(NOW - 60_000).toISOString() });
    expect(isRunStale(run, NOW)).toBe(false);
  });

  it("is true for a running row past the window", () => {
    const run = makeRun({
      startedAt: new Date(NOW - RUN_STALE_MS - 1).toISOString(),
    });
    expect(isRunStale(run, NOW)).toBe(true);
  });

  it("is false for a terminal row regardless of age", () => {
    const run = makeRun({
      status: "success",
      startedAt: new Date(NOW - RUN_STALE_MS * 10).toISOString(),
    });
    expect(isRunStale(run, NOW)).toBe(false);
  });
});
