import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "./migrate";
import { syncMerge } from "./sync-merge";

let dir: string;
let prodPath: string;
let srcPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lf-sync-"));
  prodPath = path.join(dir, "prod.db");
  srcPath = path.join(dir, "src.db");
});

describe("syncMerge", () => {
  it("merges discovery data while preserving prod feedback and finds.status", () => {
    // --- prod: a source, a starred find with feedback ---
    runMigrations(prodPath);
    const prod = new Database(prodPath);
    prod
      .prepare("INSERT INTO sources (url, name, status, added_by, created_at) VALUES (?,?,?,?,?)")
      .run("https://a.org", "A", "active", "scout", "2026-01-01");
    const prodSourceId = (prod.prepare("SELECT id FROM sources WHERE url=?").get("https://a.org") as any).id;
    prod
      .prepare("INSERT INTO finds (title, url_hash, status, agent, source_id, discovered_at) VALUES (?,?,?,?,?,?)")
      .run("Old title", "hash-1", "starred", "scout", prodSourceId, "2026-01-02");
    const prodFindId = (prod.prepare("SELECT id FROM finds WHERE url_hash=?").get("hash-1") as any).id;
    prod
      .prepare("INSERT INTO feedback (find_id, action, created_at) VALUES (?,?,?)")
      .run(prodFindId, "star", "2026-01-03");
    prod.close();

    // --- local snapshot: same source (different id), edited find, a new find ---
    runMigrations(srcPath);
    const src = new Database(srcPath);
    // bump the sources autoincrement so the local source id differs from prod's,
    // genuinely exercising the source_id remap.
    src.prepare("INSERT INTO sources (url, name, status, added_by, created_at) VALUES (?,?,?,?,?)").run("https://dummy.org", "dummy", "dead", "scout", "2026-01-01");
    src.prepare("DELETE FROM sources WHERE url=?").run("https://dummy.org");
    src.prepare("INSERT INTO sources (url, name, status, added_by, created_at) VALUES (?,?,?,?,?)").run("https://a.org", "A renamed", "active", "scout", "2026-01-01");
    const srcSourceId = (src.prepare("SELECT id FROM sources WHERE url=?").get("https://a.org") as any).id;
    expect(srcSourceId).not.toBe(prodSourceId); // remap is actually under test
    src.prepare("INSERT INTO finds (title, url_hash, summary, status, agent, source_id, discovered_at) VALUES (?,?,?,?,?,?,?)")
      .run("New title", "hash-1", "fresh summary", "new", "scout", srcSourceId, "2026-01-02");
    src.prepare("INSERT INTO finds (title, url_hash, status, agent, source_id, discovered_at) VALUES (?,?,?,?,?,?)")
      .run("Brand new", "hash-2", "new", "scout", srcSourceId, "2026-06-01");
    src.close();

    syncMerge(srcPath, prodPath);

    const out = new Database(prodPath);
    // feedback untouched
    expect((out.prepare("SELECT COUNT(*) c FROM feedback").get() as any).c).toBe(1);
    // existing find: status preserved, content updated, id (and thus FK) unchanged
    const f1 = out.prepare("SELECT * FROM finds WHERE url_hash='hash-1'").get() as any;
    expect(f1.status).toBe("starred");
    expect(f1.title).toBe("New title");
    expect(f1.summary).toBe("fresh summary");
    expect(f1.id).toBe(prodFindId);
    // new find: default status, source_id remapped to PROD's source id
    const f2 = out.prepare("SELECT * FROM finds WHERE url_hash='hash-2'").get() as any;
    expect(f2.status).toBe("new");
    expect(f2.source_id).toBe(prodSourceId);
    // source content updated, no duplicate row
    expect((out.prepare("SELECT COUNT(*) c FROM sources WHERE url='https://a.org'").get() as any).c).toBe(1);
    expect((out.prepare("SELECT name FROM sources WHERE url='https://a.org'").get() as any).name).toBe("A renamed");
    out.close();
  });

  it("preserves NULL source_id on a find that has no source", () => {
    runMigrations(prodPath);
    runMigrations(srcPath);
    const src = new Database(srcPath);
    // Insert a find with source_id = NULL (e.g. manually curated, no source)
    src.prepare("INSERT INTO finds (title, url_hash, status, agent, source_id, discovered_at) VALUES (?,?,?,?,?,?)")
      .run("Sourceless find", "hash-null-src", "new", "scout", null, "2026-06-01");
    src.close();

    syncMerge(srcPath, prodPath);

    const out = new Database(prodPath);
    const f = out.prepare("SELECT * FROM finds WHERE url_hash='hash-null-src'").get() as any;
    expect(f).toBeTruthy();
    expect(f.source_id).toBeNull();
    out.close();
  });

  it("remaps source_id to the prod-assigned id for a brand-new source from the snapshot", () => {
    runMigrations(prodPath);
    runMigrations(srcPath);

    // Prod has no sources at all — the snapshot introduces a brand-new one
    const src = new Database(srcPath);
    src.prepare("INSERT INTO sources (url, name, status, added_by, created_at) VALUES (?,?,?,?,?)")
      .run("https://brand-new.org", "Brand New Source", "active", "scout", "2026-06-01");
    const srcSourceId = (src.prepare("SELECT id FROM sources WHERE url=?").get("https://brand-new.org") as any).id;
    src.prepare("INSERT INTO finds (title, url_hash, status, agent, source_id, discovered_at) VALUES (?,?,?,?,?,?)")
      .run("New source find", "hash-new-src", "new", "scout", srcSourceId, "2026-06-01");
    src.close();

    syncMerge(srcPath, prodPath);

    const out = new Database(prodPath);
    // The source must exist in prod now
    const prodSource = out.prepare("SELECT id FROM sources WHERE url='https://brand-new.org'").get() as any;
    expect(prodSource).toBeTruthy();
    const prodSourceId = prodSource.id;

    // The find's source_id must point to prod's newly-assigned id and be non-null
    const f = out.prepare("SELECT * FROM finds WHERE url_hash='hash-new-src'").get() as any;
    expect(f).toBeTruthy();
    expect(f.source_id).not.toBeNull();
    expect(f.source_id).toBe(prodSourceId);
    out.close();
  });

  it("upserts runs (by id, mutable) and fetches (by id, immutable)", () => {
    runMigrations(prodPath);
    runMigrations(srcPath);
    const src = new Database(srcPath);
    src.prepare("INSERT INTO runs (id, agent, started_at, status) VALUES (?,?,?,?)").run(1, "scout", "2026-06-01", "success");
    src.prepare("INSERT INTO fetches (id, agent, host, url, klass, ts) VALUES (?,?,?,?,?,?)").run(1, "scout", "a.org", "https://a.org", "ok", "2026-06-01");
    src.close();

    syncMerge(srcPath, prodPath);
    // a re-sync where the run later flips to "capped" must update; fetches must not duplicate
    const src2 = new Database(srcPath);
    src2.prepare("UPDATE runs SET status='capped' WHERE id=1").run();
    src2.close();
    syncMerge(srcPath, prodPath);

    const out = new Database(prodPath);
    expect((out.prepare("SELECT status FROM runs WHERE id=1").get() as any).status).toBe("capped");
    expect((out.prepare("SELECT COUNT(*) c FROM fetches").get() as any).c).toBe(1);
    out.close();
  });
});
