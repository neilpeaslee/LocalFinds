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

// Shared by setupPgDatabase and setupPgFixtureOnly: start a fresh Postgres
// container, point LOCALFINDS_DATABASE_URL at it, then apply the fixtures
// (planet_osm.sql + optional seed_osm.sql) followed by `extraFiles` — in the
// SAME order as db/tests/conftest.py — via a plain admin client. Each applied
// file's basename is pushed onto `record`; setupPgFixtureOnly passes a
// throwaway array so MIGRATIONS_APPLIED stays untouched when no migrations run.
async function startContainerAndApply(extraFiles: string[], record: string[]): Promise<void> {
  container = await new PostgreSqlContainer("postgis/postgis:15-3.4").start();
  const url = container.getConnectionUri(); // postgresql://...
  process.env.LOCALFINDS_DATABASE_URL = url;

  const files: string[] = [path.join(FIXTURES, "planet_osm.sql")];
  const seed = path.join(FIXTURES, "seed_osm.sql");
  try { readFileSync(seed); files.push(seed); } catch { /* optional */ }
  files.push(...extraFiles);

  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  try {
    for (const f of files) {
      await admin.query(readFileSync(f, "utf8")); // simple-query protocol runs multi-statement scripts
      record.push(path.basename(f));
    }
  } finally {
    await admin.end();
  }
}

export async function setupPgDatabase(): Promise<void> {
  const migrations = readdirSync(MIGRATIONS)
    .filter((n) => n.endsWith(".sql"))
    .sort()
    .map((f) => path.join(MIGRATIONS, f));
  await startContainerAndApply(migrations, MIGRATIONS_APPLIED);
}

export async function teardownPgDatabase(): Promise<void> {
  await container?.stop();
  container = undefined;
  MIGRATIONS_APPLIED.length = 0;
}

const LOCALFINDS_TABLES = ["place_annotations", "sources", "finds", "feedback", "run_events", "runs", "fetches", "custom_places"];

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
// exercising the migration runner against a fresh schema.
export async function setupPgFixtureOnly(): Promise<void> {
  await startContainerAndApply([], []);
}
