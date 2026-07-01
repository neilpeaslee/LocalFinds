import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { pool, query, tx } from "./client";
import { findRepoRoot } from "./paths";

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

function migrationDir(): string {
  return path.join(findRepoRoot(), "db", "migrations");
}

export function migrationFilenames(): string[] {
  return readdirSync(migrationDir())
    .filter((n) => n.endsWith(".sql"))
    .sort();
}

// Apply every db/migrations/*.sql not already recorded in public.schema_migrations,
// each file in its own transaction (SQL + bookkeeping insert together). Idempotent:
// a re-run applies nothing. Aborts on the first failing file (its txn rolls back).
export async function runMigrations(): Promise<MigrationResult> {
  await query(
    `CREATE TABLE IF NOT EXISTS public.schema_migrations (
       filename   text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
  const done = new Set(
    (await query<{ filename: string }>(`SELECT filename FROM public.schema_migrations`)).map(
      (r) => r.filename,
    ),
  );

  const applied: string[] = [];
  const skipped: string[] = [];
  const dir = migrationDir();
  for (const name of migrationFilenames()) {
    if (done.has(name)) {
      skipped.push(name);
      continue;
    }
    const sql = readFileSync(path.join(dir, name), "utf8");
    await tx(async (c) => {
      // No params => simple-query protocol, so the multi-statement migration file
      // runs as one script. (query()/execute() would force single-statement.)
      await c.query(sql);
      await c.query(`INSERT INTO public.schema_migrations (filename) VALUES ($1)`, [name]);
    });
    applied.push(name);
  }
  return { applied, skipped };
}

// CLI entry: `tsx src/migrate.ts` (reads LOCALFINDS_DATABASE_URL). Guarded so that
// importing this module (migrate.test.ts) never runs a migration as a side effect.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { applied, skipped } = await runMigrations();
    console.log(
      `migrate: applied ${applied.length}` +
        (applied.length ? ` (${applied.join(", ")})` : "") +
        `, skipped ${skipped.length}`,
    );
  } catch (err) {
    console.error("migrate: failed —", err);
    process.exitCode = 1;
  } finally {
    await pool().end();
  }
}
