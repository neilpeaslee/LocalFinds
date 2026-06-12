import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { dbPath } from "./paths";
import * as schema from "./schema";

function createDb() {
  const file = dbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  // WAL + busy_timeout: agents write while the web app reads on the same file
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

let _db: ReturnType<typeof createDb> | undefined;

export function db() {
  return (_db ??= createDb());
}

export type Db = ReturnType<typeof db>;
