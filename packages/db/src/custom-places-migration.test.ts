import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupPgFixtureOnly, teardownPgDatabase } from "../test/harness";
import { pool, query, queryOne } from "./client";
import { findRepoRoot } from "./paths";
import { migrationFilenames, runMigrations } from "./migrate";

const MIGRATIONS_DIR = path.join(findRepoRoot(), "db", "migrations");

// Recreate the pre-0005 world: migrations 0001–0004 applied, plus one legacy
// synthetic node (the interim convention 0005 must migrate) with a linked
// lead find and an annotation whose note mentions the old id.
beforeAll(async () => {
  await setupPgFixtureOnly();
  const pre = migrationFilenames().filter((n) => n < "0005");
  const client = await pool().connect();
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS public.schema_migrations
         (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    for (const name of pre) {
      await client.query(readFileSync(path.join(MIGRATIONS_DIR, name), "utf8"));
      await client.query(`INSERT INTO public.schema_migrations (filename) VALUES ($1)`, [name]);
    }
    // NOTE: the brief's INSERT listed flat `name, office` columns as if
    // planet_osm_point were the full osm2pgsql production schema; this repo's
    // fixture table is the reduced (osm_id, tags, way) shape used throughout
    // db/tests/fixtures/seed_osm.sql. Fixed to match — same data, real columns.
    await client.query(`
      INSERT INTO planet_osm_point (osm_id, tags, way) VALUES
      (900000000000001,
       hstore(ARRAY['name','Test Law Office','office','lawyer',
         'addr:housenumber','10','addr:street','School Street','addr:city','Rockland',
         'website','https://testlaw.example.com',
         'localfinds:added','2026-07-02 legal-services scan']),
       ST_Transform(ST_SetSRID(ST_MakePoint(-69.11, 44.10), 4326), 3857))
    `);
    await client.query(`REFRESH MATERIALIZED VIEW public.osm_places`);
    await client.query(`
      INSERT INTO localfinds.place_annotations (osm_id, note, added_by)
      VALUES ('node/900000000000001', 'stale — see node/900000000000001', 'claude')
    `);
    await client.query(`
      INSERT INTO localfinds.finds (title, url_hash, agent, type, place_osm_id)
      VALUES ('Test Law Office', 'testhash-cp', 'claude', 'lead', 'node/900000000000001')
    `);
  } finally {
    client.release();
  }
  await runMigrations(); // applies exactly 0005 against the seeded legacy state
}, 180_000);

afterAll(teardownPgDatabase);

describe("0005_custom_places", () => {
  it("moves the synthetic node into custom_places with parsed fields", async () => {
    const row = await queryOne<{
      name: string; category: string; housenumber: string; street: string;
      city: string; state: string; website: string; source_url: string;
      lat: number; lng: number;
    }>(`SELECT name, category, housenumber, street, city, state, website,
               source_url, lat, lng
        FROM localfinds.custom_places WHERE name = 'Test Law Office'`);
    expect(row).toBeDefined();
    expect(row!.category).toBe("office=lawyer");
    expect(row!.housenumber).toBe("10");
    expect(row!.street).toBe("School Street");
    expect(row!.city).toBe("Rockland");
    expect(row!.state).toBe("ME");
    expect(row!.website).toBe("https://testlaw.example.com");
    expect(row!.source_url).toBe("migrated: 2026-07-02 legal-services scan");
    expect(row!.lat).toBeCloseTo(44.10, 4);
    expect(row!.lng).toBeCloseTo(-69.11, 4);
  });

  it("deletes the synthetic node from planet_osm_point", async () => {
    const rows = await query(
      `SELECT osm_id FROM planet_osm_point WHERE osm_id >= 900000000000000`,
    );
    expect(rows).toHaveLength(0);
  });

  it("remaps the lead find and the annotation to the custom/<n> id", async () => {
    const id = (await queryOne<{ id: number }>(
      `SELECT id FROM localfinds.custom_places WHERE name = 'Test Law Office'`,
    ))!.id;
    const find = await queryOne<{ place_osm_id: string }>(
      `SELECT place_osm_id FROM localfinds.finds WHERE url_hash = 'testhash-cp'`,
    );
    expect(find!.place_osm_id).toBe(`custom/${id}`);
    const ann = await queryOne<{ osm_id: string; note: string }>(
      `SELECT osm_id, note FROM localfinds.place_annotations WHERE osm_id = 'custom/' || $1::text`,
      [id],
    );
    expect(ann).toBeDefined();
    expect(ann!.note).toBe(`stale — see custom/${id}`); // free-text mention rewritten
    const old = await query(
      `SELECT 1 FROM localfinds.place_annotations WHERE osm_id = 'node/900000000000001'`,
    );
    expect(old).toHaveLength(0);
  });

  it("surfaces the custom place through localfinds.places with derived kind/town/address", async () => {
    const place = await queryOne<{
      osm_id: string; kind: string; town: string; address: string; website: string; status: string;
    }>(`SELECT osm_id, kind, town, address, website, status
        FROM localfinds.places WHERE name = 'Test Law Office'`);
    expect(place).toBeDefined();
    expect(place!.osm_id).toMatch(/^custom\/\d+$/);
    expect(place!.kind).toBe("office=lawyer");
    expect(place!.town).toBe("Rockland"); // spatial join against fixture boundary
    expect(place!.address).toBe("10 School Street, Rockland");
    expect(place!.website).toBe("https://testlaw.example.com");
    expect(place!.status).toBe("active");
  });

  it("enforces the category CHECK constraint", async () => {
    await expect(
      query(`INSERT INTO localfinds.custom_places
             (name, category, lat, lng, source_url, added_by)
             VALUES ('Bad', 'building=yes', 44.1, -69.1, 'https://x.example', 'test')`),
    ).rejects.toThrow(/custom_places_category_key_chk/);
  });
});
