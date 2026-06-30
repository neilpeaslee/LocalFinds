import { afterAll, beforeAll, expect, it } from "vitest";
import pg from "pg";
import { MIGRATIONS_APPLIED, setupPgDatabase, teardownPgDatabase } from "./harness";

beforeAll(setupPgDatabase, 120_000);
afterAll(teardownPgDatabase);

it("applies the canonical migrations and builds osm_places", async () => {
  expect(MIGRATIONS_APPLIED).toContain("0001_localfinds_schema.sql");
  expect(MIGRATIONS_APPLIED).toContain("0002_osm_places.sql");
  const client = new pg.Client({ connectionString: process.env.LOCALFINDS_DATABASE_URL });
  await client.connect();
  try {
    const places = await client.query("SELECT count(*)::int AS n FROM public.osm_places");
    expect(places.rows[0].n).toBeGreaterThan(0); // seed_osm.sql has rows
    const finds = await client.query("SELECT count(*)::int AS n FROM localfinds.finds");
    expect(finds.rows[0].n).toBe(0);
  } finally {
    await client.end();
  }
});
