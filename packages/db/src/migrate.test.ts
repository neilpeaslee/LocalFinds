import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "./migrate";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lf-migrate-"));
});

describe("runMigrations", () => {
  it("creates the full schema on a fresh database", () => {
    const file = path.join(dir, "fresh.db");
    runMigrations(file);

    const db = new Database(file);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r: any) => r.name);
    for (const t of ["sources", "finds", "feedback", "businesses", "runs", "fetches"]) {
      expect(tables).toContain(t);
    }
    // schema completeness spot-checks for the two newest additions
    const findCols = db.prepare("PRAGMA table_info(sources)").all().map((c: any) => c.name);
    expect(findCols).toContain("ical_url");
    db.close();
  });

  it("is idempotent — a second run is a no-op", () => {
    const file = path.join(dir, "twice.db");
    runMigrations(file);
    expect(() => runMigrations(file)).not.toThrow();
  });
});
