import { describe, expect, it } from "vitest";
import { type FeedDefaults, type FeedState, feedHref } from "./feed-url";

const state = (o: Partial<FeedState> = {}): FeedState => ({
  view: "default",
  pageSize: 50,
  density: "full",
  sort: "newest",
  ...o,
});
const defaults = (o: Partial<FeedDefaults> = {}): FeedDefaults => ({
  view: "default",
  pageSize: 50,
  density: "full",
  sort: "newest",
  ...o,
});

describe("feedHref", () => {
  it("omits values equal to the cookie default", () => {
    expect(feedHref(state(), defaults())).toBe("/feed");
  });

  it("emits a value that differs from the cookie default (the 50-vs-25 bug)", () => {
    // cookie default 25/soonest; picking 50 must emit size=50, not silently revert
    const d = defaults({ pageSize: 25, sort: "soonest" });
    expect(feedHref(state({ pageSize: 50, sort: "soonest" }), d)).toBe("/feed?size=50");
  });

  it("lets you pick the hardcoded-default sort when the cookie default differs", () => {
    expect(feedHref(state({ sort: "newest" }), defaults({ sort: "soonest" }))).toBe(
      "/feed?sort=newest",
    );
  });

  it("emits days=any to override a persisted date default, else stays clean", () => {
    expect(feedHref(state(), defaults({ days: 7 }))).toBe("/feed?days=any");
    expect(feedHref(state(), defaults())).toBe("/feed");
  });

  it("handles windows and ranges against the default", () => {
    expect(feedHref(state({ days: 7 }), defaults())).toBe("/feed?days=7");
    expect(feedHref(state({ days: 7 }), defaults({ days: 7 }))).toBe("/feed");
    expect(feedHref(state({ from: "2026-07-01", to: "2026-07-31" }), defaults())).toBe(
      "/feed?from=2026-07-01&to=2026-07-31",
    );
  });

  it("adds page only when > 1, and tags when present", () => {
    expect(feedHref(state(), defaults(), 1)).toBe("/feed");
    expect(feedHref(state(), defaults(), 3)).toBe("/feed?page=3");
    expect(feedHref(state({ tag: "music" }), defaults())).toBe("/feed?tag=music");
  });

  it("emits type ad-hoc (never part of the cookie defaults)", () => {
    expect(feedHref(state({ type: "lead" }), defaults())).toBe("/feed?type=lead");
    expect(feedHref(state(), defaults())).toBe("/feed");
  });
});
