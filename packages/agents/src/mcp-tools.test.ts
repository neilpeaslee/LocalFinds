import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { resetDb, setupPgDatabase, teardownPgDatabase } from "@localfinds/db/test-harness";
import { resolveFindStatus } from "./mcp-tools";

let recordSourceUpsert: (typeof import("./mcp-tools"))["recordSourceUpsert"];

beforeAll(async () => {
  await setupPgDatabase();
  ({ recordSourceUpsert } = await import("./mcp-tools"));
}, 120_000);

afterAll(teardownPgDatabase);
afterEach(resetDb);

describe("recordSourceUpsert run counters", () => {
  it("counts a brand-new source as added, not updated", async () => {
    const counters = { added: 0, updated: 0 };
    await recordSourceUpsert(
      { url: "https://new-source.example.com", name: "New Source" },
      "source-keeper",
      counters,
    );
    expect(counters).toEqual({ added: 1, updated: 0 });
  });

  it("counts a re-upsert of the same URL as updated, not added", async () => {
    const args = { url: "https://existing.example.com", name: "Existing" };
    await recordSourceUpsert(args, "source-keeper", { added: 0, updated: 0 }); // create
    const counters = { added: 0, updated: 0 };
    await recordSourceUpsert(args, "source-keeper", counters); // re-upsert
    expect(counters).toEqual({ added: 0, updated: 1 });
  });
});

describe("resolveFindStatus", () => {
  it("defaults to undefined (insertFind will use 'new')", () => {
    expect(resolveFindStatus(undefined)).toBeUndefined();
  });
  it("returns the override when set", () => {
    expect(resolveFindStatus("provisional")).toBe("provisional");
  });
});

describe("recordSourceUpsert ical_url", () => {
  it("passes ical_url through to the sources row", async () => {
    const { listSources } = await import("@localfinds/db");
    const counters = { added: 0, updated: 0 };
    await recordSourceUpsert(
      { url: "https://feedvenue.org/", ical_url: "https://feedvenue.org/events/?ical=1" },
      "source-keeper",
      counters,
    );
    const row = (await listSources()).find((s) => s.url === "https://feedvenue.org/");
    expect(row?.icalUrl).toBe("https://feedvenue.org/events/?ical=1");
  });
});
