import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { resetDb, setupPgDatabase, teardownPgDatabase } from "../test/harness";
import { pool, queryOne } from "./client";
import {
  insertCustomPlace,
  refreshOsmPlaces,
  upsertPlaceAnnotation,
  type NewCustomPlaceInput,
} from "./custom-places";

beforeAll(setupPgDatabase, 180_000);
afterAll(teardownPgDatabase);
afterEach(async () => {
  await resetDb();
  await refreshOsmPlaces(); // drop truncated custom rows out of the matview
});

const BASE: NewCustomPlaceInput = {
  name: "Testy & Sons, P.A.",
  category: "office=lawyer",
  housenumber: "10",
  street: "School Street",
  city: "Rockland",
  lat: 44.10,
  lng: -69.11,
  website: "https://testysons.example.com",
  sourceUrl: "https://testysons.example.com/about",
  addedBy: "concierge",
};

describe("insertCustomPlace", () => {
  it("creates a place and surfaces it in localfinds.places after refresh", async () => {
    const result = await insertCustomPlace(BASE);
    expect(result.outcome).toBe("created");
    expect(result.osmId).toMatch(/^custom\/\d+$/);

    await refreshOsmPlaces();
    const place = await queryOne<{ kind: string; town: string; address: string }>(
      `SELECT kind, town, address FROM localfinds.places WHERE osm_id = $1`,
      [result.osmId],
    );
    expect(place).toEqual({
      kind: "office=lawyer",
      town: "Rockland",
      address: "10 School Street, Rockland",
    });
  });

  it("rejects an unsurfaced category key", async () => {
    await expect(
      insertCustomPlace({ ...BASE, category: "building=yes" }),
    ).rejects.toThrow(/custom_places_category_key_chk/);
  });

  it("returns duplicate for the same normalized name in the same town (matview hit)", async () => {
    const first = await insertCustomPlace(BASE);
    await refreshOsmPlaces();
    const dup = await insertCustomPlace({
      ...BASE,
      // "Testy & Sons, P.A." and "TESTY SONS P.A." both normalize to "testy sons p a"
      // (punctuation runs collapse to single spaces; "&" folds away).
      name: "TESTY SONS P.A.",
      lat: 44.20, lng: -69.20, // far away — town match must suffice
    });
    expect(dup).toEqual({ outcome: "duplicate", osmId: first.osmId });
  });

  it("returns duplicate for a same-run insert (matview stale — direct table check)", async () => {
    const first = await insertCustomPlace(BASE);
    // NO refresh — mimics a second save_place in the same agent run.
    const dup = await insertCustomPlace({ ...BASE });
    expect(dup).toEqual({ outcome: "duplicate", osmId: first.osmId });
  });

  it("returns duplicate against an existing OSM place within 100 m with the same name", async () => {
    // Fixture node/1 is "Rock City Coffee" at ~(44.10, -69.11) (see queries.test.ts).
    const dup = await insertCustomPlace({
      ...BASE,
      name: "Rock City Coffee",
      category: "amenity=cafe",
      city: "Elsewhere", // town mismatch — proximity match must catch it
      lat: 44.10, lng: -69.10995,
    });
    expect(dup.outcome).toBe("duplicate");
    expect(dup.osmId).toBe("node/1");
  });

  it("returns duplicate for a matview place ~85 m away (geodesic, not Mercator-planar)", async () => {
    // node/1 "Rock City Coffee" is at (44.10, -69.11); +0.000765° lat ≈ 85 m
    // north — inside a true geodesic 100 m, but ~118 planar 3857 units at
    // ~44°N (Mercator scale 1/cos(44.1°) ≈ 1.39), so a planar
    // ST_DWithin(point, ..., 100) misses this band. node/1 exists ONLY in the
    // matview (not custom_places), pinning the matview-side check specifically.
    const dup = await insertCustomPlace({
      ...BASE,
      name: "Rock City Coffee",
      category: "amenity=cafe",
      city: "Elsewhere", // town mismatch — proximity match must do the work
      lat: 44.100765, lng: -69.11,
    });
    expect(dup).toEqual({ outcome: "duplicate", osmId: "node/1" });
  });
});

describe("upsertPlaceAnnotation", () => {
  it("rejects an osm_id that exists nowhere", async () => {
    const result = await upsertPlaceAnnotation({
      osmId: "node/424242424242", note: "x", addedBy: "concierge",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/unknown osm_id/);
  });

  it("creates, then partially updates, preserving created_at and unset fields", async () => {
    const created = await upsertPlaceAnnotation({
      osmId: "node/1", note: "first note", statusOverride: "unknown", addedBy: "concierge",
    });
    expect(created.ok).toBe(true);
    const before = await queryOne<{ created_at: string; note: string; status_override: string }>(
      `SELECT created_at, note, status_override FROM localfinds.place_annotations WHERE osm_id = 'node/1'`,
    );

    const updated = await upsertPlaceAnnotation({
      osmId: "node/1", statusOverride: "closed", addedBy: "concierge",
    });
    expect(updated.ok).toBe(true);
    const after = await queryOne<{ created_at: string; note: string; status_override: string }>(
      `SELECT created_at, note, status_override FROM localfinds.place_annotations WHERE osm_id = 'node/1'`,
    );
    expect(after!.created_at).toEqual(before!.created_at);
    expect(after!.note).toBe("first note"); // unset field preserved
    expect(after!.status_override).toBe("closed");
  });

  it("clears status_override with 'clear'", async () => {
    await upsertPlaceAnnotation({ osmId: "node/1", statusOverride: "closed", addedBy: "concierge" });
    await upsertPlaceAnnotation({ osmId: "node/1", statusOverride: "clear", addedBy: "concierge" });
    const row = await queryOne<{ status_override: string | null }>(
      `SELECT status_override FROM localfinds.place_annotations WHERE osm_id = 'node/1'`,
    );
    expect(row!.status_override).toBeNull();
  });

  it("accepts a custom place not yet in the matview (same-run annotate)", async () => {
    const place = await insertCustomPlace(BASE); // no refresh
    const result = await upsertPlaceAnnotation({
      osmId: place.osmId, note: "added this run", addedBy: "concierge",
    });
    expect(result.ok).toBe(true);
  });
});
