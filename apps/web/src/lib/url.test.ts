import { describe, expect, it } from "vitest";
import { first, hrefWith } from "./url";

describe("first", () => {
  it("takes the first of a repeated query key, passes through scalars", () => {
    expect(first(["a", "b"])).toBe("a");
    expect(first("a")).toBe("a");
    expect(first(undefined)).toBeUndefined();
  });
});

describe("hrefWith", () => {
  it("merges patch onto current and drops empty values", () => {
    expect(hrefWith("/feed", { view: "starred" }, { page: "2" })).toBe(
      "/feed?view=starred&page=2",
    );
    expect(hrefWith("/feed", { view: undefined }, {})).toBe("/feed");
  });

  it("lets a patch clear a current value (back to the bare path)", () => {
    expect(hrefWith("/feed", { size: "25" }, { size: undefined })).toBe("/feed");
  });
});
