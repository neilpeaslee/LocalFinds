import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dbPath } from "./paths";
import { migrationsFolder } from "./migrate";

interface JournalEntry {
  tag: string;
  when: number;
}

/**
 * Record every migration currently in the folder as already-applied in the
 * target DB, WITHOUT running its SQL. For adopting existing databases (created
 * via drizzle-kit push) into the migration system. Idempotent.
 */
export function adoptBaseline(
  file: string = dbPath(),
): { marked: string[]; skipped: string[] } {
  const folder = migrationsFolder();
  const journal = JSON.parse(
    fs.readFileSync(path.join(folder, "meta", "_journal.json"), "utf8"),
  ) as { entries: JournalEntry[] };

  const sqlite = new Database(file);
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS `__drizzle_migrations` (" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, hash text NOT NULL, created_at numeric)",
  );
  const existing = new Set(
    sqlite
      .prepare("SELECT hash FROM `__drizzle_migrations`")
      .all()
      .map((r: any) => r.hash as string),
  );
  const insert = sqlite.prepare(
    "INSERT INTO `__drizzle_migrations` (hash, created_at) VALUES (?, ?)",
  );

  const marked: string[] = [];
  const skipped: string[] = [];
  for (const entry of journal.entries) {
    const sql = fs.readFileSync(path.join(folder, `${entry.tag}.sql`), "utf8");
    const hash = crypto.createHash("sha256").update(sql).digest("hex");
    if (existing.has(hash)) {
      skipped.push(entry.tag);
      continue;
    }
    insert.run(hash, entry.when);
    marked.push(entry.tag);
  }
  sqlite.close();
  return { marked, skipped };
}

// CLI entry: `tsx src/adopt-migrations.ts` adopts the resolved data-dir DB.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = adoptBaseline();
  console.log(`adopted: marked=[${result.marked.join(",")}] skipped=[${result.skipped.join(",")}]`);
}
