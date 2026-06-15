import { describe, expect, it } from "vitest";
import { pageWindow, parsePageSize } from "./pagination";

describe("parsePageSize", () => {
  it("accepts the known sizes", () => {
    expect(parsePageSize("25")).toBe(25);
    expect(parsePageSize("50")).toBe(50);
    expect(parsePageSize("100")).toBe(100);
    expect(parsePageSize("all")).toBe("all");
  });

  it("defaults missing or invalid values to 50", () => {
    expect(parsePageSize(undefined)).toBe(50);
    expect(parsePageSize("")).toBe(50);
    expect(parsePageSize("17")).toBe(50);
    expect(parsePageSize("banana")).toBe(50);
  });
});

describe("pageWindow", () => {
  it("lists every page when there is no gap", () => {
    expect(pageWindow(1, 3)).toEqual([1, 2, 3]);
  });

  it("collapses both sides around a middle page", () => {
    expect(pageWindow(6, 12)).toEqual([1, "ellipsis", 5, 6, 7, "ellipsis", 12]);
  });

  it("collapses only the trailing gap near the start", () => {
    expect(pageWindow(2, 12)).toEqual([1, 2, 3, "ellipsis", 12]);
  });

  it("collapses only the leading gap near the end", () => {
    expect(pageWindow(11, 12)).toEqual([1, "ellipsis", 10, 11, 12]);
  });

  it("returns a single page for one or zero pages", () => {
    expect(pageWindow(1, 1)).toEqual([1]);
  });

  it("fills a single-page gap instead of showing an ellipsis", () => {
    expect(pageWindow(1, 4)).toEqual([1, 2, 3, 4]);
    expect(pageWindow(4, 4)).toEqual([1, 2, 3, 4]);
  });
});
