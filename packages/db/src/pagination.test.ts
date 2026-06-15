import { describe, expect, it } from "vitest";
import { resolvePage } from "./pagination";

describe("resolvePage", () => {
  it("returns the first-page window", () => {
    expect(resolvePage(10, 1, 4)).toEqual({ page: 1, pageCount: 3, start: 0, end: 4 });
  });

  it("returns a middle-page window", () => {
    expect(resolvePage(10, 2, 4)).toEqual({ page: 2, pageCount: 3, start: 4, end: 8 });
  });

  it("trims the partial last page to `matched`", () => {
    expect(resolvePage(10, 3, 4)).toEqual({ page: 3, pageCount: 3, start: 8, end: 10 });
  });

  it("clamps a too-high page down to the last page", () => {
    expect(resolvePage(10, 99, 4)).toEqual({ page: 3, pageCount: 3, start: 8, end: 10 });
  });

  it("clamps page below 1 up to 1", () => {
    expect(resolvePage(10, 0, 4)).toEqual({ page: 1, pageCount: 3, start: 0, end: 4 });
  });

  it("treats an empty set as a single empty page", () => {
    expect(resolvePage(0, 1, 4)).toEqual({ page: 1, pageCount: 1, start: 0, end: 0 });
  });

  it("treats pageSize of 1 as one item per page", () => {
    expect(resolvePage(3, 2, 1)).toEqual({ page: 2, pageCount: 3, start: 1, end: 2 });
  });

  it("coerces a non-positive pageSize to 1", () => {
    expect(resolvePage(3, 1, 0)).toEqual({ page: 1, pageCount: 3, start: 0, end: 1 });
  });

  it("coerces a NaN page to the first page", () => {
    expect(resolvePage(10, Number.NaN, 4)).toEqual({ page: 1, pageCount: 3, start: 0, end: 4 });
  });
});
