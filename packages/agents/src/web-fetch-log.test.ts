import { describe, expect, it } from "vitest";
import { classifyWebFetchResult, hostOf, webFetchResultText } from "./web-fetch-log";

describe("classifyWebFetchResult", () => {
  it("classifies a 403 as blocked", () => {
    expect(classifyWebFetchResult("The server returned HTTP 403 Forbidden.")).toEqual({ klass: "blocked", status: 403 });
  });
  it("classifies a 401 as blocked", () => {
    expect(classifyWebFetchResult("The server returned HTTP 401 Unauthorized.")).toEqual({ klass: "blocked", status: 401 });
  });
  it("classifies other HTTP codes as error", () => {
    expect(classifyWebFetchResult("The server returned HTTP 500.")).toEqual({ klass: "error", status: 500 });
  });
  it("classifies truncation as truncated/200", () => {
    expect(classifyWebFetchResult("Some content...\n[Content truncated due to length...]")).toEqual({ klass: "truncated", status: 200 });
  });
  it("classifies plain content as ok/200", () => {
    expect(classifyWebFetchResult("# Events\n- Concert on July 4")).toEqual({ klass: "ok", status: 200 });
  });
});

describe("webFetchResultText", () => {
  it("returns a string as-is", () => {
    expect(webFetchResultText("hello")).toBe("hello");
  });
  it("joins a text-block array", () => {
    expect(webFetchResultText([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("a\nb");
  });
  it("stringifies anything else without throwing", () => {
    expect(typeof webFetchResultText({ weird: 1 })).toBe("string");
  });
});

describe("hostOf", () => {
  it("extracts a lowercase hostname", () => {
    expect(hostOf("https://Owlshead.org/events/")).toBe("owlshead.org");
  });
  it("returns null on an unparseable url", () => {
    expect(hostOf("not a url")).toBeNull();
  });
});
