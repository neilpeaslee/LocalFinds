import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  type Settings,
  mergeSettings,
  resolveFeed,
} from "./settings";

const withFeed = (patch: Partial<Settings["feed"]>): Settings => ({
  feed: { ...DEFAULT_SETTINGS.feed, ...patch },
});

describe("mergeSettings", () => {
  it("applies valid cookie fields and ignores unknown ones", () => {
    const merged = mergeSettings(DEFAULT_SETTINGS, {
      feed: { pageSize: 25, density: "compact", junk: "x" },
    });
    expect(merged.feed.pageSize).toBe(25);
    expect(merged.feed.density).toBe("compact");
    expect(merged.feed.view).toBe("default"); // untouched -> from defaults
  });

  it("falls back to defaults for tampered/garbage values", () => {
    const merged = mergeSettings(DEFAULT_SETTINGS, {
      feed: { view: "bogus", pageSize: "banana", sort: "sideways" },
    });
    expect(merged.feed).toEqual(DEFAULT_SETTINGS.feed);
  });

  it("survives a non-object cookie payload", () => {
    expect(mergeSettings(DEFAULT_SETTINGS, null)).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings(DEFAULT_SETTINGS, "nope")).toEqual(DEFAULT_SETTINGS);
  });
});

describe("resolveFeed precedence (URL > cookie > default)", () => {
  it("returns hardcoded defaults for empty params and default settings", () => {
    const r = resolveFeed({}, DEFAULT_SETTINGS);
    expect(r).toMatchObject({
      view: "default",
      pageSize: 50,
      density: "full",
      sort: "newest",
      page: 1,
    });
    expect(r.days).toBeUndefined();
    expect(r.from).toBeUndefined();
  });

  it("uses cookie defaults when no URL param is present", () => {
    const settings = withFeed({ pageSize: 25, density: "compact", sort: "oldest" });
    const r = resolveFeed({}, settings);
    expect(r).toMatchObject({ pageSize: 25, density: "compact", sort: "oldest" });
  });

  it("lets a URL param override the cookie default", () => {
    const settings = withFeed({ pageSize: 25 });
    expect(resolveFeed({ size: "100" }, settings).pageSize).toBe(100);
  });

  it("passes through the 'soonest' sort (event-date ordering)", () => {
    expect(resolveFeed({ sort: "soonest" }, DEFAULT_SETTINGS).sort).toBe("soonest");
    expect(resolveFeed({}, withFeed({ sort: "soonest" })).sort).toBe("soonest");
  });

  it("keeps page ad-hoc — never from the cookie", () => {
    expect(resolveFeed({ page: "3" }, DEFAULT_SETTINGS).page).toBe(3);
    expect(resolveFeed({}, withFeed({})).page).toBe(1);
  });
});

describe("resolveFeed date precedence (URL range > URL days > cookie range > cookie days)", () => {
  it("URL range beats a URL days window", () => {
    const r = resolveFeed({ from: "2026-02-01", to: "2026-02-05", days: "7" }, DEFAULT_SETTINGS);
    expect(r.from).toBe("2026-02-01");
    expect(r.to).toBe("2026-02-05");
    expect(r.days).toBeUndefined();
  });

  it("URL days beats a cookie range", () => {
    const settings = withFeed({ from: "2026-01-01", to: "2026-01-31" });
    const r = resolveFeed({ days: "7" }, settings);
    expect(r.days).toBe(7);
    expect(r.from).toBeUndefined();
  });

  it("treats days=any as an explicit 'no date', overriding a cookie date default", () => {
    const r = resolveFeed({ days: "any" }, withFeed({ days: 7 }));
    expect(r.days).toBeUndefined();
    expect(r.from).toBeUndefined();
  });

  it("falls through to the cookie range, then the cookie days window", () => {
    const ranged = resolveFeed({}, withFeed({ from: "2026-03-01", to: "2026-03-10", days: 7 }));
    expect(ranged.from).toBe("2026-03-01");
    expect(ranged.days).toBeUndefined(); // a cookie range outranks a cookie window

    const windowed = resolveFeed({}, withFeed({ days: 30 }));
    expect(windowed.days).toBe(30);
    expect(windowed.from).toBeUndefined();
  });
});
