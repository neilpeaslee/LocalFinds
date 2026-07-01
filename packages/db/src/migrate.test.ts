import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setupPgFixtureOnly, teardownPgDatabase } from "../test/harness";
import { pool, query } from "./client";
import { findRepoRoot } from "./paths";
import { migrationFilenames, runMigrations } from "./migrate";

const MIGRATIONS_DIR = path.join(findRepoRoot(), "db", "migrations");

// Return to the fixture-only baseline (planet_osm + extensions remain) so each
// test starts from a fresh, un-migrated schema.
async function resetToFixtureOnly(): Promise<void> {
  await query(`DROP SCHEMA IF EXISTS localfinds CASCADE`);
  await query(`DROP MATERIALIZED VIEW IF EXISTS public.osm_places CASCADE`);
  await query(`DROP TABLE IF EXISTS public.schema_migrations`);
}

beforeAll(setupPgFixtureOnly, 120_000);
afterAll(teardownPgDatabase);
afterEach(resetToFixtureOnly);

describe("runMigrations", () => {
  it("applies all pending migrations to a fresh DB and records them", async () => {
    const { applied, skipped } = await runMigrations();
    expect(applied).toEqual(migrationFilenames());
    expect(skipped).toEqual([]);

    const recorded = await query<{ filename: string }>(
      `SELECT filename FROM public.schema_migrations ORDER BY filename`,
    );
    expect(recorded.map((r) => r.filename)).toEqual(migrationFilenames());

    // an object created by each migration now exists
    const [objs] = await query<{
      finds: string | null;
      places_mv: string | null;
      places_v: string | null;
      run_events: string | null;
    }>(
      `SELECT to_regclass('localfinds.finds')::text     AS finds,
              to_regclass('public.osm_places')::text    AS places_mv,
              to_regclass('localfinds.places')::text    AS places_v,
              to_regclass('localfinds.run_events')::text AS run_events`,
    );
    expect(objs.finds).not.toBeNull();
    expect(objs.places_mv).not.toBeNull();
    expect(objs.places_v).not.toBeNull();
    expect(objs.run_events).not.toBeNull();
  });

  it("is idempotent — a second run applies nothing", async () => {
    await runMigrations();
    const second = await runMigrations();
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(migrationFilenames());

    const [{ n }] = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.schema_migrations`,
    );
    expect(n).toBe(migrationFilenames().length);
  });

  it("applies only the migrations not yet recorded", async () => {
    const names = migrationFilenames();
    const preApplied = names.slice(0, 2);

    // Simulate a partial prior state: apply + record the first two by hand.
    await query(
      `CREATE TABLE IF NOT EXISTS public.schema_migrations
         (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    const client = await pool().connect();
    try {
      for (const name of preApplied) {
        await client.query(readFileSync(path.join(MIGRATIONS_DIR, name), "utf8"));
        await client.query(`INSERT INTO public.schema_migrations (filename) VALUES ($1)`, [name]);
      }
    } finally {
      client.release();
    }

    const { applied, skipped } = await runMigrations();
    expect(applied).toEqual(names.slice(2));
    expect(skipped).toEqual(preApplied);
  });
});
