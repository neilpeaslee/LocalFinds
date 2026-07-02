import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { resetDb, setupPgDatabase, teardownPgDatabase } from "@localfinds/db/test-harness";
import { resolveFindStatus } from "./mcp-tools";
import type { AddressGeocodeResult, AddressInput } from "./geocode";

let recordSourceUpsert: (typeof import("./mcp-tools"))["recordSourceUpsert"];

beforeAll(async () => {
  await setupPgDatabase();
  ({ recordSourceUpsert } = await import("./mcp-tools"));
}, 120_000);

afterAll(teardownPgDatabase);
afterEach(resetDb);

describe("recordSourceUpsert run counters", () => {
  it("counts a brand-new source as added, not updated", async () => {
    const counters = { added: 0, updated: 0, placesAdded: 0 };
    await recordSourceUpsert(
      { url: "https://new-source.example.com", name: "New Source" },
      "source-keeper",
      counters,
    );
    expect(counters).toEqual({ added: 1, updated: 0, placesAdded: 0 });
  });

  it("counts a re-upsert of the same URL as updated, not added", async () => {
    const args = { url: "https://existing.example.com", name: "Existing" };
    await recordSourceUpsert(args, "source-keeper", { added: 0, updated: 0, placesAdded: 0 }); // create
    const counters = { added: 0, updated: 0, placesAdded: 0 };
    await recordSourceUpsert(args, "source-keeper", counters); // re-upsert
    expect(counters).toEqual({ added: 0, updated: 1, placesAdded: 0 });
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
    const counters = { added: 0, updated: 0, placesAdded: 0 };
    await recordSourceUpsert(
      { url: "https://feedvenue.org/", ical_url: "https://feedvenue.org/events/?ical=1" },
      "source-keeper",
      counters,
    );
    const row = (await listSources()).find((s) => s.url === "https://feedvenue.org/");
    expect(row?.icalUrl).toBe("https://feedvenue.org/events/?ical=1");
  });
});

const okGeocode = async (_: AddressInput): Promise<AddressGeocodeResult> =>
  ({ ok: true, lat: 44.10, lng: -69.11, displayName: "test" });

describe("recordPlaceSave", () => {
  it("geocodes, inserts, and bumps added + placesAdded", async () => {
    const { recordPlaceSave } = await import("./mcp-tools");
    const counters = { added: 0, updated: 0, placesAdded: 0 };
    const result = await recordPlaceSave(
      {
        name: "Testy & Sons, P.A.", category: "office=lawyer",
        housenumber: "10", street: "School Street", city: "Rockland",
        source_url: "https://testysons.example.com/about",
      },
      "concierge", counters, okGeocode,
    );
    expect(result.outcome).toBe("created");
    if (result.outcome === "created") expect(result.osmId).toMatch(/^custom\//);
    expect(counters).toEqual({ added: 1, updated: 0, placesAdded: 1 });
  });

  it("rejects a category outside the six surfaced keys without geocoding", async () => {
    const { recordPlaceSave } = await import("./mcp-tools");
    let geocodeCalls = 0;
    const counters = { added: 0, updated: 0, placesAdded: 0 };
    const result = await recordPlaceSave(
      { name: "X", category: "building=yes", city: "Rockland", source_url: "https://x.example" },
      "concierge", counters,
      async (input) => { geocodeCalls++; return okGeocode(input); },
    );
    expect(result.outcome).toBe("error");
    expect(geocodeCalls).toBe(0);
    expect(counters.placesAdded).toBe(0);
  });

  it("surfaces geocode failure as an error outcome, not a throw", async () => {
    const { recordPlaceSave } = await import("./mcp-tools");
    const counters = { added: 0, updated: 0, placesAdded: 0 };
    const result = await recordPlaceSave(
      { name: "X", category: "office=lawyer", city: "Rockland", source_url: "https://x.example" },
      "concierge", counters,
      async () => ({ ok: false, error: "No geocoding match for \"X\"" }),
    );
    expect(result.outcome).toBe("error");
    if (result.outcome === "error") expect(result.reason).toMatch(/geocoding failed/);
    expect(counters).toEqual({ added: 0, updated: 0, placesAdded: 0 });
  });

  it("does not bump placesAdded on duplicate", async () => {
    const { recordPlaceSave } = await import("./mcp-tools");
    const args = {
      name: "Dup & Co", category: "office=lawyer",
      street: "Main Street", city: "Rockland",
      source_url: "https://dup.example",
    };
    await recordPlaceSave(args, "concierge", { added: 0, updated: 0, placesAdded: 0 }, okGeocode);
    const counters = { added: 0, updated: 0, placesAdded: 0 };
    const result = await recordPlaceSave(args, "concierge", counters, okGeocode);
    expect(result.outcome).toBe("duplicate");
    expect(counters).toEqual({ added: 0, updated: 0, placesAdded: 0 });
  });
});

describe("recordPlaceAnnotation", () => {
  it("requires at least one annotation field", async () => {
    const { recordPlaceAnnotation } = await import("./mcp-tools");
    const counters = { added: 0, updated: 0, placesAdded: 0 };
    const result = await recordPlaceAnnotation({ osm_id: "node/1" }, "concierge", counters);
    expect(result.ok).toBe(false);
    expect(counters.updated).toBe(0);
  });

  it("annotates an existing place and bumps updated", async () => {
    const { recordPlaceAnnotation } = await import("./mcp-tools");
    const counters = { added: 0, updated: 0, placesAdded: 0 };
    const result = await recordPlaceAnnotation(
      { osm_id: "node/1", note: "renamed per 2026 scan", status_override: "unknown" },
      "concierge", counters,
    );
    expect(result.ok).toBe(true);
    expect(counters.updated).toBe(1);
  });

  it("propagates the unknown-osm_id guard", async () => {
    const { recordPlaceAnnotation } = await import("./mcp-tools");
    const counters = { added: 0, updated: 0, placesAdded: 0 };
    const result = await recordPlaceAnnotation(
      { osm_id: "node/424242424242", note: "x" }, "concierge", counters,
    );
    expect(result.ok).toBe(false);
    expect(counters.updated).toBe(0);
  });
});
