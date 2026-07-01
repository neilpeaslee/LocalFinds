import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB_ROOT = path.resolve(HERE, "../../../db"); // repo-root db/ (canonical migrations + fixtures)
const MIGRATIONS = path.join(DB_ROOT, "migrations");
const FIXTURES = path.join(DB_ROOT, "tests", "fixtures");

let container: StartedPostgreSqlContainer | undefined;

export const MIGRATIONS_APPLIED: string[] = [];

export async function setupPgDatabase(): Promise<void> {
  container = await new PostgreSqlContainer("postgis/postgis:15-3.4").start();
  const url = container.getConnectionUri(); // postgresql://...
  process.env.LOCALFINDS_DATABASE_URL = url;

  // Apply in the SAME order as db/tests/conftest.py.
  const files: string[] = [path.join(FIXTURES, "planet_osm.sql")];
  const seed = path.join(FIXTURES, "seed_osm.sql");
  try { readFileSync(seed); files.push(seed); } catch { /* optional */ }
  for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) {
    files.push(path.join(MIGRATIONS, f));
  }

  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  try {
    for (const f of files) {
      await admin.query(readFileSync(f, "utf8")); // simple-query protocol runs multi-statement scripts
      MIGRATIONS_APPLIED.push(path.basename(f));
    }
  } finally {
    await admin.end();
  }
}

export async function teardownPgDatabase(): Promise<void> {
  await container?.stop();
  container = undefined;
  MIGRATIONS_APPLIED.length = 0;
}

const LOCALFINDS_TABLES = ["place_annotations", "sources", "finds", "feedback", "run_events", "runs", "fetches"];

export async function resetDb(): Promise<void> {
  const client = new pg.Client({ connectionString: process.env.LOCALFINDS_DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      `TRUNCATE ${LOCALFINDS_TABLES.map((t) => `localfinds.${t}`).join(", ")} RESTART IDENTITY CASCADE`,
    );
  } finally {
    await client.end();
  }
}

// Fixture-only setup: extensions + planet_osm fixtures, but NO migrations — for
// exercising the migration runner against a fresh schema. Deliberately standalone
// (a few lines duplicated) to keep the migrated-DB setupPgDatabase byte-identical.
export async function setupPgFixtureOnly(): Promise<void> {
  container = await new PostgreSqlContainer("postgis/postgis:15-3.4").start();
  const url = container.getConnectionUri();
  process.env.LOCALFINDS_DATABASE_URL = url;

  const files = [path.join(FIXTURES, "planet_osm.sql")];
  const seed = path.join(FIXTURES, "seed_osm.sql");
  try {
    readFileSync(seed);
    files.push(seed);
  } catch {
    /* optional */
  }

  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  try {
    for (const f of files) await admin.query(readFileSync(f, "utf8"));
  } finally {
    await admin.end();
  }
}
