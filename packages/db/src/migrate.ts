import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { dbPath } from "./paths";

/** Absolute path to the committed migrations folder (packages/db/drizzle). */
export function migrationsFolder(): string {
  return path.join(import.meta.dirname, "..", "drizzle");
}

/** Apply all pending migrations to the SQLite file (defaults to dbPath()). */
export function runMigrations(file: string = dbPath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: migrationsFolder() });
  sqlite.close();
}

// CLI entry: `tsx src/migrate.ts` migrates the resolved data-dir DB.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runMigrations();
  console.log("migrations applied");
}
