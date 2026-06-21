import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { adoptBaseline } from "./adopt-migrations";
import { runMigrations } from "./migrate";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lf-adopt-"));
});

describe("adoptBaseline", () => {
  it("marks the baseline as applied and is idempotent", () => {
    const file = path.join(dir, "existing.db");
    new Database(file).close(); // empty DB, no __drizzle_migrations yet

    const first = adoptBaseline(file);
    expect(first.marked.length).toBeGreaterThanOrEqual(1);
    expect(first.skipped).toEqual([]);

    const second = adoptBaseline(file);
    expect(second.marked).toEqual([]);
    expect(second.skipped.length).toBe(first.marked.length);

    const db = new Database(file);
    const rows = db.prepare("SELECT hash, created_at FROM __drizzle_migrations").all();
    expect(rows.length).toBe(first.marked.length); // no duplicate rows
    db.close();
  });

  it("prevents runMigrations from replaying an adopted migration", () => {
    const file = path.join(dir, "adopted.db");
    new Database(file).close();

    adoptBaseline(file); // baseline recorded as applied
    runMigrations(file); // must SKIP 0000 (would otherwise CREATE the tables)

    const db = new Database(file);
    const finds = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='finds'")
      .get();
    expect(finds).toBeUndefined(); // 0000 was skipped → finds never created
    db.close();
  });
});
