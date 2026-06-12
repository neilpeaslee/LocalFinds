import { describe, expect, it } from "vitest";
import { findKey, normalizeTitle, normalizeUrl } from "./dedupe";

describe("normalizeUrl", () => {
  it("strips tracking params", () => {
    expect(
      normalizeUrl("https://example.com/a?utm_source=x&utm_medium=y&id=5"),
    ).toBe("example.com/a?id=5");
    expect(normalizeUrl("https://example.com/a?fbclid=abc&gclid=def")).toBe(
      "example.com/a",
    );
  });

  it("strips www, lowercases host, drops scheme and hash", () => {
    expect(normalizeUrl("HTTP://WWW.Example.COM/Path#section")).toBe(
      "example.com/Path",
    );
  });

  it("removes trailing slashes", () => {
    expect(normalizeUrl("https://example.com/events/")).toBe(
      "example.com/events",
    );
    expect(normalizeUrl("https://example.com/")).toBe("example.com");
  });

  it("sorts query params for stable comparison", () => {
    expect(normalizeUrl("https://example.com/a?b=2&a=1")).toBe(
      normalizeUrl("https://example.com/a?a=1&b=2"),
    );
  });

  it("lowercases non-URL input instead of throwing", () => {
    expect(normalizeUrl("Not A URL")).toBe("not a url");
  });
});

describe("normalizeTitle", () => {
  it("collapses whitespace and lowercases", () => {
    expect(normalizeTitle("  Big   Event\n2026 ")).toBe("big event 2026");
  });
});

describe("findKey", () => {
  it("treats url variants as the same find", () => {
    const a = findKey({
      url: "https://www.example.com/events/?utm_source=mail",
      title: "A",
    });
    const b = findKey({ url: "http://example.com/events", title: "B" });
    expect(a).toBe(b);
  });

  it("differs for different urls", () => {
    expect(findKey({ url: "https://example.com/a", title: "T" })).not.toBe(
      findKey({ url: "https://example.com/b", title: "T" }),
    );
  });

  it("falls back to normalized title when url is missing", () => {
    expect(findKey({ title: "Big  Event" })).toBe(
      findKey({ url: null, title: "big event" }),
    );
    expect(findKey({ title: "Big Event" })).not.toBe(
      findKey({ title: "Other Event" }),
    );
  });

  it("keeps url-keyed and title-keyed spaces distinct", () => {
    expect(findKey({ url: "https://example.com/x", title: "x" })).not.toBe(
      findKey({ title: "https://example.com/x" }),
    );
  });
});
