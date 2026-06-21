# CI/CD Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local scripted CI/CD pipeline that gates on tests+typecheck, applies versioned DB migrations to prod, deploys the committed code tree, and merges local agent-generated content into prod without clobbering prod-side user activity.

**Architecture:** A single `deploy` orchestrator runs four composable stages — `gate` → `migrate` → `deploy-code` → `sync-content`. The two stages with real logic are TypeScript modules in `packages/db` (`migrate.ts`, `sync-merge.ts`) so they are unit-tested; the orchestration is thin shell scripts in `scripts/deploy/` that read all infra details from a gitignored `data/config/deploy.env`.

**Tech Stack:** TypeScript, drizzle-orm 0.45.2 + drizzle-kit 0.31.10 (better-sqlite3), Bash, rsync/ssh, pm2, vitest.

## Global Constraints

- **`git add` and `git commit` are ALWAYS separate Bash calls** — never combine them.
- **The repo is PUBLIC** (github.com/neilpeaslee/LocalFinds) — no IPs, hosts, or infra details in committed files. All such values live only in gitignored `data/config/deploy.env`.
- **PII boundary:** everything under `data/**` is gitignored except `data/**/*.example`. `data/config/deploy.env` is therefore already gitignored; `data/config/deploy.env.example` is committed.
- **Commit trailers required** on every commit:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_017HvawEEAoQzxnBfWMgpPsK
  ```
- **Migrator facts (verified against installed drizzle-orm 0.45.2):** the migrations table is `__drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash text NOT NULL, created_at numeric)`. A migration runs iff `!lastDbMigration || Number(lastDbMigration.created_at) < migration.folderMillis`. `hash = sha256(<full .sql file contents>)`; `folderMillis = journal entry's "when"`.
- **`finds` content columns** (everything except `id`, `url_hash`, and `status`): `title, url, summary, event_start, event_end, expires_at, published_at, discovered_at, agent, source_id, tags, score`.

---

### Task 1: Versioned-migrations foundation

Switch drizzle from `push` to a committed migrations folder, generate the baseline `0000` migration, and add a programmatic `runMigrations()` used by the pipeline and tests.

**Files:**
- Modify: `packages/db/drizzle.config.ts` (add `out`)
- Create: `packages/db/drizzle/0000_*.sql` + `packages/db/drizzle/meta/*` (generated)
- Create: `packages/db/src/migrate.ts`
- Test: `packages/db/src/migrate.test.ts`

**Interfaces:**
- Produces: `migrationsFolder(): string` — absolute path to `packages/db/drizzle`. `runMigrations(file?: string): void` — applies all pending migrations to the SQLite file at `file` (defaults to `dbPath()`), creating it if absent.

- [ ] **Step 1: Add `out` to the drizzle config**

Modify `packages/db/drizzle.config.ts` to:

```ts
import { defineConfig } from "drizzle-kit";
import { dbPath } from "./src/paths";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: dbPath() },
});
```

- [ ] **Step 2: Generate the baseline migration**

Run: `cd packages/db && npx drizzle-kit generate`
Expected: creates `packages/db/drizzle/0000_<somename>.sql` (full schema: `sources`, `finds`, `feedback`, `businesses`, `runs`, `fetches`, all indexes) and `packages/db/drizzle/meta/_journal.json` + `0000_snapshot.json`. Non-interactive.

Verify it captured the current schema (must mention `fetches` and `ical_url`):
Run: `grep -l "ical_url" packages/db/drizzle/0000_*.sql && grep -l "CREATE TABLE \`fetches\`" packages/db/drizzle/0000_*.sql`
Expected: both grep succeed (print the filename).

- [ ] **Step 3: Write the failing test for `runMigrations`**

Create `packages/db/src/migrate.test.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd packages/db && npx vitest run src/migrate.test.ts`
Expected: FAIL — `Cannot find module './migrate'`.

- [ ] **Step 5: Implement `migrate.ts`**

Create `packages/db/src/migrate.ts`:

```ts
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
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd packages/db && npx vitest run src/migrate.test.ts`
Expected: PASS (both tests).

- [ ] **Step 7: Commit**

```bash
git add packages/db/drizzle.config.ts packages/db/drizzle packages/db/src/migrate.ts packages/db/src/migrate.test.ts
```
```bash
git commit -m "$(cat <<'EOF'
feat(db): versioned migrations — baseline 0000 + runMigrations()

Adds out:"./drizzle" to the drizzle config, generates the baseline migration
capturing the current schema (incl. fetches + sources.ical_url), and a
programmatic runMigrations() used by the pipeline and tests. Replaces
drizzle-kit push as the schema-change mechanism.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017HvawEEAoQzxnBfWMgpPsK
EOF
)"
```

---

### Task 2: Migration baseline-adoption for existing DBs

Existing DBs (local has the full schema; prod is one change behind) must be *adopted* into the migration system without replaying `0000` over their existing tables. This script marks already-present migrations as applied.

**Files:**
- Create: `packages/db/src/adopt-migrations.ts`
- Test: `packages/db/src/adopt-migrations.test.ts`

**Interfaces:**
- Consumes: `migrationsFolder()` from `./migrate`.
- Produces: `adoptBaseline(file?: string): { marked: string[]; skipped: string[] }` — seeds `__drizzle_migrations` so every migration currently in the folder is recorded as applied (without running its SQL); idempotent. Returns which tags it newly `marked` vs already-present (`skipped`).

- [ ] **Step 1: Write the failing test**

Create `packages/db/src/adopt-migrations.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/db && npx vitest run src/adopt-migrations.test.ts`
Expected: FAIL — `Cannot find module './adopt-migrations'`.

- [ ] **Step 3: Implement `adopt-migrations.ts`**

Replicates exactly what drizzle's migrator would write (table shape, hash = sha256 of the `.sql` file, `created_at` = journal `when`), so a later `runMigrations` sees the baseline as already applied.

Create `packages/db/src/adopt-migrations.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/db && npx vitest run src/adopt-migrations.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/adopt-migrations.ts packages/db/src/adopt-migrations.test.ts
```
```bash
git commit -m "$(cat <<'EOF'
feat(db): adoptBaseline() to migrate existing DBs into versioned migrations

Seeds __drizzle_migrations (matching drizzle's exact hash/created_at scheme) so
an existing push-created DB records the baseline as applied and runMigrations
skips it instead of CREATE-ing over live tables. Idempotent. Used once during
rollout against the local and prod DBs.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017HvawEEAoQzxnBfWMgpPsK
EOF
)"
```

---

### Task 3: Content merge (`sync-merge.ts`)

The heart of content sync: upsert discovery tables from a shipped snapshot into prod, remapping foreign keys by natural key, while never touching `feedback` or `finds.status`.

**Files:**
- Create: `packages/db/src/sync-merge.ts`
- Test: `packages/db/src/sync-merge.test.ts`

**Interfaces:**
- Consumes: `runMigrations` from `./migrate` (test only); `dbPath` from `./paths`.
- Produces: `syncMerge(incomingPath: string, prodPath?: string): void` — opens the prod DB (defaults to `dbPath()`), `ATTACH`es the incoming snapshot, and in one transaction upserts `sources` (by `url`), `businesses` (by `osm_id`), `finds` (by `url_hash`, content cols only), `runs` (by `id`), `fetches` (by `id`); never reads `src.feedback`, never writes `main.finds.status`. `finds.source_id` is remapped from the snapshot's source id to the prod source id sharing the same `url`. New `finds`/`sources`/`businesses` get prod-assigned ids (so existing prod `feedback.find_id` FKs stay valid); `runs`/`fetches` preserve their ids (local owns that id space).

- [ ] **Step 1: Write the failing test**

Create `packages/db/src/sync-merge.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/db && npx vitest run src/sync-merge.test.ts`
Expected: FAIL — `Cannot find module './sync-merge'`.

- [ ] **Step 3: Implement `sync-merge.ts`**

`WHERE true` before each `ON CONFLICT` is the SQLite requirement that disambiguates an upsert in an `INSERT ... SELECT`. `finds` omits the `status` column on insert (so the schema default `new` applies) and omits it from the update set (so prod's status is preserved). `source_id` is resolved via a correlated subquery joining snapshot→prod sources on `url`.

Create `packages/db/src/sync-merge.ts`:

```ts
import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dbPath } from "./paths";

/**
 * Merge a local snapshot's discovery data into the prod DB. Local is
 * authoritative for sources/finds/businesses/runs/fetches; prod is authoritative
 * for user activity — feedback rows and finds.status are never written here.
 */
export function syncMerge(incomingPath: string, prodPath: string = dbPath()): void {
  const db = new Database(prodPath);
  db.pragma("foreign_keys = ON");
  db.prepare("ATTACH DATABASE ? AS src").run(incomingPath);

  const tx = db.transaction(() => {
    // sources — upsert by url
    db.exec(`
      INSERT INTO main.sources
        (url, name, notes_path, ical_url, status, quality_score, finds_count, last_find_at, last_checked_at, added_by, created_at)
      SELECT
        url, name, notes_path, ical_url, status, quality_score, finds_count, last_find_at, last_checked_at, added_by, created_at
      FROM src.sources WHERE true
      ON CONFLICT(url) DO UPDATE SET
        name=excluded.name, notes_path=excluded.notes_path, ical_url=excluded.ical_url,
        status=excluded.status, quality_score=excluded.quality_score, finds_count=excluded.finds_count,
        last_find_at=excluded.last_find_at, last_checked_at=excluded.last_checked_at, added_by=excluded.added_by
    `);

    // businesses — upsert by osm_id
    db.exec(`
      INSERT INTO main.businesses
        (osm_id, name, kind, tags, address, town, lat, lng, website, phone, brand, status, notes_path, added_by, discovered_at, last_seen_at, duplicate_of)
      SELECT
        osm_id, name, kind, tags, address, town, lat, lng, website, phone, brand, status, notes_path, added_by, discovered_at, last_seen_at, duplicate_of
      FROM src.businesses WHERE true
      ON CONFLICT(osm_id) DO UPDATE SET
        name=excluded.name, kind=excluded.kind, tags=excluded.tags, address=excluded.address,
        town=excluded.town, lat=excluded.lat, lng=excluded.lng, website=excluded.website, phone=excluded.phone,
        brand=excluded.brand, status=excluded.status, notes_path=excluded.notes_path, added_by=excluded.added_by,
        last_seen_at=excluded.last_seen_at, duplicate_of=excluded.duplicate_of
    `);

    // finds — upsert by url_hash; NEVER write status; remap source_id by url.
    // status is omitted on insert (schema default 'new') and from the update set.
    db.exec(`
      INSERT INTO main.finds
        (title, url, url_hash, summary, event_start, event_end, expires_at, published_at, discovered_at, agent, source_id, tags, score)
      SELECT
        s.title, s.url, s.url_hash, s.summary, s.event_start, s.event_end, s.expires_at, s.published_at, s.discovered_at, s.agent,
        (SELECT m.id FROM main.sources m JOIN src.sources ss ON ss.url = m.url WHERE ss.id = s.source_id),
        s.tags, s.score
      FROM src.finds s WHERE true
      ON CONFLICT(url_hash) DO UPDATE SET
        title=excluded.title, url=excluded.url, summary=excluded.summary,
        event_start=excluded.event_start, event_end=excluded.event_end, expires_at=excluded.expires_at,
        published_at=excluded.published_at, agent=excluded.agent, source_id=excluded.source_id,
        tags=excluded.tags, score=excluded.score
    `);

    // runs — preserve id (local owns the id space); prod never writes runs, so
    // overwriting mutable fields from local is always correct.
    db.exec(`
      INSERT INTO main.runs
        (id, agent, started_at, finished_at, status, items_added, items_updated, warnings, num_turns, cost_usd, usage_json, session_id, error)
      SELECT
        id, agent, started_at, finished_at, status, items_added, items_updated, warnings, num_turns, cost_usd, usage_json, session_id, error
      FROM src.runs WHERE true
      ON CONFLICT(id) DO UPDATE SET
        agent=excluded.agent, started_at=excluded.started_at, finished_at=excluded.finished_at, status=excluded.status,
        items_added=excluded.items_added, items_updated=excluded.items_updated, warnings=excluded.warnings,
        num_turns=excluded.num_turns, cost_usd=excluded.cost_usd, usage_json=excluded.usage_json,
        session_id=excluded.session_id, error=excluded.error
    `);

    // fetches — preserve id + run_id; immutable, so skip rows already present.
    db.exec(`
      INSERT INTO main.fetches
        (id, run_id, agent, host, url, method, status, klass, via, ts)
      SELECT
        id, run_id, agent, host, url, method, status, klass, via, ts
      FROM src.fetches WHERE true
      ON CONFLICT(id) DO NOTHING
    `);
  });
  tx();

  db.exec("DETACH DATABASE src");
  db.close();
}

// CLI entry: `tsx src/sync-merge.ts <incoming.db> [prod.db]`
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const incoming = process.argv[2];
  if (!incoming) {
    console.error("usage: tsx src/sync-merge.ts <incoming-snapshot.db> [prod-db]");
    process.exit(1);
  }
  syncMerge(incoming, process.argv[3]);
  console.log("content merge complete");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/db && npx vitest run src/sync-merge.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Run the whole db suite to check for regressions**

Run: `cd packages/db && npx vitest run`
Expected: PASS (all existing tests + the 3 new files).

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/sync-merge.ts packages/db/src/sync-merge.test.ts
```
```bash
git commit -m "$(cat <<'EOF'
feat(db): syncMerge() — merge local discovery data into prod, preserve activity

ATTACHes a local snapshot and upserts sources/finds/businesses/runs/fetches in
one transaction. finds.status and the feedback table are never written (prod is
authoritative for user activity); finds.source_id is remapped to the prod source
sharing the same url; new discovery rows take prod-assigned ids so existing
feedback FKs stay valid.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017HvawEEAoQzxnBfWMgpPsK
EOF
)"
```

---

### Task 4: Config + shared lib + gate stage

The gitignored config, its committed example, the shared shell helpers, and the local-only gate stage.

**Files:**
- Create: `data/config/deploy.env.example` (committed)
- Create: `scripts/deploy/lib.sh`
- Create: `scripts/deploy/gate.sh`

**Interfaces:**
- Produces: `scripts/deploy/lib.sh` defines `remote "<cmd>"` (runs `<cmd>` on the server inside the nvm prefix + `cd $DEPLOY_PATH`) and `push_file <local> <remote-rel>` (rsync one file into `$DEPLOY_PATH/<remote-rel>`); both respect a `--dry-run` arg by printing instead of executing. Sets and validates `DEPLOY_HOST`, `DEPLOY_PATH`, `DEPLOY_DB`, `DEPLOY_NVM_PREFIX`, `DEPLOY_PM2_NAME` from `data/config/deploy.env`. `gate.sh` exits non-zero unless on `main`, tree clean, `npm test` passes, and `tsc --noEmit` passes for all three packages.

- [ ] **Step 1: Create the committed config example**

Create `data/config/deploy.env.example`:

```bash
# LocalFinds deploy config — copy to deploy.env (gitignored) and fill in.
# Infra-specific values live ONLY here, never in committed scripts.

# SSH alias for the server (resolves to the real host via ~/.ssh/config).
DEPLOY_HOST=your-ssh-alias
# App directory on the server (repo root there).
DEPLOY_PATH=/var/www/localfinds
# DB path relative to DEPLOY_PATH on the server.
DEPLOY_DB=data/localfinds.db
# Prepended to every remote node/npm/pm2 command (nvm bootstrap).
DEPLOY_NVM_PREFIX="export NVM_DIR=\$HOME/.nvm; . \$NVM_DIR/nvm.sh;"
# pm2 process name to reload after a deploy.
DEPLOY_PM2_NAME=localfinds
```

- [ ] **Step 2: Verify the example is committable but `deploy.env` is ignored**

Run: `git check-ignore data/config/deploy.env.example; echo "example-status=$?"; git check-ignore data/config/deploy.env; echo "env-status=$?"`
Expected: `example-status=1` (NOT ignored — committable) and `env-status=0` (ignored). If the example is ignored, the `!data/**/*.example` rule isn't matching — stop and fix `.gitignore` before continuing.

- [ ] **Step 3: Create `lib.sh`**

Create `scripts/deploy/lib.sh`:

```bash
# Shared helpers for the deploy pipeline. Sourced by the stage scripts.
# Loads infra config from data/config/deploy.env (gitignored) so committed
# scripts carry no host/path details.
set -euo pipefail

DEPLOY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEPLOY_CONFIG="$DEPLOY_ROOT/data/config/deploy.env"

if [ ! -f "$DEPLOY_CONFIG" ]; then
  echo "deploy: missing $DEPLOY_CONFIG" >&2
  echo "deploy: copy data/config/deploy.env.example to data/config/deploy.env and fill it in" >&2
  exit 1
fi
# shellcheck disable=SC1090
. "$DEPLOY_CONFIG"

: "${DEPLOY_HOST:?set in deploy.env}"
: "${DEPLOY_PATH:?set in deploy.env}"
: "${DEPLOY_DB:?set in deploy.env}"
: "${DEPLOY_NVM_PREFIX:?set in deploy.env}"
: "${DEPLOY_PM2_NAME:?set in deploy.env}"

DRY_RUN=0
for arg in "$@"; do
  [ "$arg" = "--dry-run" ] && DRY_RUN=1
done

# Run a command on the server inside the nvm prefix and the app directory.
remote() {
  local cmd="$DEPLOY_NVM_PREFIX cd $DEPLOY_PATH && $*"
  if [ "$DRY_RUN" = 1 ]; then
    echo "DRY remote> $cmd"
  else
    ssh "$DEPLOY_HOST" "$cmd"
  fi
}

# rsync one local file to $DEPLOY_PATH/<remote-rel> on the server.
push_file() {
  local src="$1" dest_rel="$2"
  if [ "$DRY_RUN" = 1 ]; then
    echo "DRY rsync> $src -> $DEPLOY_HOST:$DEPLOY_PATH/$dest_rel"
  else
    rsync -az "$src" "$DEPLOY_HOST:$DEPLOY_PATH/$dest_rel"
  fi
}
```

- [ ] **Step 4: Create `gate.sh`**

`gate.sh` is intentionally standalone (it does NOT source `lib.sh`, so you can gate without a deploy config). The apps/web typecheck relies on `next-env.d.ts` existing locally (Next regenerates it; it's gitignored but present on the dev machine).

Create `scripts/deploy/gate.sh`:

```bash
#!/usr/bin/env bash
# Pre-deploy gate: refuse to deploy unless the branch is clean main and both
# tests AND typecheck pass across all packages. Local-only; no SSH, no config.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$branch" != "main" ]; then
  echo "gate: on '$branch', not 'main' — refusing to deploy" >&2
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "gate: working tree not clean — deploy ships committed files only" >&2
  git status --short >&2
  exit 1
fi

echo "gate: running tests"
npm test

echo "gate: typechecking all packages"
for p in packages/db packages/agents apps/web; do
  echo "gate: tsc --noEmit ($p)"
  ( cd "$p" && npx tsc --noEmit )
done

echo "gate: PASS"
```

- [ ] **Step 5: Make the scripts executable and smoke-test the gate**

```bash
chmod +x scripts/deploy/gate.sh scripts/deploy/lib.sh
```

This must be run from a clean tree on main. Because the new files are not yet committed, run the gate AFTER staging+committing in the next step would be circular — instead verify the gate's failure path now (it should report the tree is dirty), proving the check works:

Run: `bash scripts/deploy/gate.sh; echo "exit=$?"`
Expected: prints `gate: working tree not clean` and `exit=1` (the new untracked files make the tree dirty — this is the gate correctly refusing).

- [ ] **Step 6: Commit**

```bash
git add data/config/deploy.env.example scripts/deploy/lib.sh scripts/deploy/gate.sh
```
```bash
git commit -m "$(cat <<'EOF'
feat(deploy): pipeline config, shared lib, and gate stage

Adds the committed deploy.env.example (infra values stay in gitignored
data/config/deploy.env), lib.sh (remote/push_file helpers + --dry-run), and
gate.sh (refuses deploy unless clean main + npm test + tsc --noEmit pass for all
three packages — the run-#31 "vitest doesn't typecheck" guard).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017HvawEEAoQzxnBfWMgpPsK
EOF
)"
```

- [ ] **Step 7: Verify the gate now passes on the clean tree**

Run: `bash scripts/deploy/gate.sh; echo "exit=$?"`
Expected: runs tests + typecheck, prints `gate: PASS`, `exit=0`.

---

### Task 5: Migrate + deploy-code stages

The schema-migration stage (backup prod, apply migrations locally and on prod) and the code-deploy stage (rsync committed tree, conditional `npm ci`, build, reload, verify).

**Files:**
- Create: `scripts/deploy/migrate.sh`
- Create: `scripts/deploy/deploy-code.sh`

**Interfaces:**
- Consumes: `lib.sh` (`remote`, config vars, `DRY_RUN`); `packages/db/src/migrate.ts` CLI.
- Produces: `migrate.sh` — backs up prod DB, runs `runMigrations` locally then on prod. `deploy-code.sh` — rsyncs `git ls-files`, runs `npm ci` only when `package-lock.json` changed, builds web, reloads pm2, verifies GET=200/POST=401.

- [ ] **Step 1: Create `migrate.sh`**

Create `scripts/deploy/migrate.sh`:

```bash
#!/usr/bin/env bash
# Migrate stage: apply versioned migrations to local + prod DBs. Backs up the
# prod DB first. Non-interactive (no drizzle-kit push prompt).
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

cd "$DEPLOY_ROOT"

echo "migrate: applying migrations locally"
if [ "$DRY_RUN" = 1 ]; then
  echo "DRY local> npx tsx packages/db/src/migrate.ts"
else
  ( cd packages/db && npx tsx src/migrate.ts )
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
echo "migrate: backing up prod DB -> ${DEPLOY_DB}.bak-${STAMP}"
remote "sqlite3 ${DEPLOY_DB} \".backup '${DEPLOY_DB}.bak-${STAMP}'\""

echo "migrate: applying migrations on prod"
remote "npx tsx packages/db/src/migrate.ts"

echo "migrate: done"
```

- [ ] **Step 2: Create `deploy-code.sh`**

Create `scripts/deploy/deploy-code.sh`:

```bash
#!/usr/bin/env bash
# Deploy-code stage: ship the committed tree, install/build/reload on the server.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

cd "$DEPLOY_ROOT"

# Detect whether package-lock changed BEFORE rsync (after rsync they'd match).
LOCAL_LOCK="$(sha256sum package-lock.json | cut -d' ' -f1)"
REMOTE_LOCK="$(ssh "$DEPLOY_HOST" "sha256sum $DEPLOY_PATH/package-lock.json 2>/dev/null | cut -d' ' -f1" || true)"

echo "deploy-code: rsync committed tree"
if [ "$DRY_RUN" = 1 ]; then
  echo "DRY rsync> git ls-files -> $DEPLOY_HOST:$DEPLOY_PATH/"
else
  rsync -az --files-from=<(git ls-files) ./ "$DEPLOY_HOST:$DEPLOY_PATH/"
fi

if [ "$LOCAL_LOCK" != "$REMOTE_LOCK" ]; then
  echo "deploy-code: package-lock changed — npm ci"
  remote "npm ci"
else
  echo "deploy-code: package-lock unchanged — skipping npm ci"
fi

echo "deploy-code: build + reload"
remote "npm run build -w @localfinds/web"
remote "pm2 reload $DEPLOY_PM2_NAME && pm2 save"

if [ "$DRY_RUN" != 1 ]; then
  echo "deploy-code: verify"
  curl -sS -o /dev/null -w "GET %{http_code}\n"  "https://localfinds.peaslee.org/"
  curl -sS -o /dev/null -w "POST %{http_code}\n" -X POST "https://localfinds.peaslee.org/"
fi

echo "deploy-code: done"
```

Note: the verify URL is the public site address (already public, in the gitignored skill and on the live cert) — not infra-sensitive. If you prefer zero hardcoded hostnames, add `DEPLOY_PUBLIC_URL` to `deploy.env` and use it here; left inline to keep the diff small.

- [ ] **Step 3: Make executable and dry-run both stages**

```bash
chmod +x scripts/deploy/migrate.sh scripts/deploy/deploy-code.sh
```

This requires `data/config/deploy.env` to exist locally. If it does not yet, create it from the example first (it's gitignored). Then:

Run: `bash scripts/deploy/migrate.sh --dry-run && bash scripts/deploy/deploy-code.sh --dry-run`
Expected: prints `DRY remote>` / `DRY rsync>` / `DRY local>` lines for every mutating action and exits 0, performing no SSH mutations.

- [ ] **Step 4: Commit**

```bash
git add scripts/deploy/migrate.sh scripts/deploy/deploy-code.sh
```
```bash
git commit -m "$(cat <<'EOF'
feat(deploy): migrate and deploy-code stages

migrate.sh applies versioned migrations to local + prod (prod DB backed up
first, non-interactive). deploy-code.sh rsyncs the committed tree, runs npm ci
only when package-lock changed, builds web, reloads pm2, and verifies
GET=200/POST=401. Both honor --dry-run.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017HvawEEAoQzxnBfWMgpPsK
EOF
)"
```

---

### Task 6: Sync-content stage + orchestrator + npm scripts

The content-sync stage (snapshot → ship → backup → merge → reload), the top-level orchestrator, and the npm-script entry points.

**Files:**
- Create: `scripts/deploy/sync-content.sh`
- Create: `scripts/deploy/deploy.sh`
- Modify: root `package.json` (scripts block)

**Interfaces:**
- Consumes: `lib.sh`; `packages/db/src/sync-merge.ts` CLI; the other three stage scripts.
- Produces: npm scripts `deploy`, `deploy:gate`, `deploy:migrate`, `deploy:code`, `deploy:sync-content`. `deploy.sh` runs the four stages in order, forwarding `--dry-run`.

- [ ] **Step 1: Create `sync-content.sh`**

Create `scripts/deploy/sync-content.sh`:

```bash
#!/usr/bin/env bash
# Sync-content stage: ship a consistent local snapshot and merge it into prod
# (discovery data only; prod feedback + finds.status are preserved). Backs up
# the prod DB first.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

cd "$DEPLOY_ROOT"

SNAP="/tmp/localfinds-sync.db"
INCOMING_REL="data/.sync-incoming.db"
STAMP="$(date +%Y%m%d-%H%M%S)"

echo "sync-content: snapshot local DB"
if [ "$DRY_RUN" = 1 ]; then
  echo "DRY local> sqlite3 data/localfinds.db .backup $SNAP"
else
  sqlite3 data/localfinds.db ".backup '$SNAP'"
fi

echo "sync-content: ship snapshot -> $INCOMING_REL"
push_file "$SNAP" "$INCOMING_REL"

echo "sync-content: backup prod DB -> ${DEPLOY_DB}.bak-${STAMP}"
remote "sqlite3 ${DEPLOY_DB} \".backup '${DEPLOY_DB}.bak-${STAMP}'\""

echo "sync-content: merge on prod"
remote "npx tsx packages/db/src/sync-merge.ts ${INCOMING_REL} ${DEPLOY_DB}"

echo "sync-content: cleanup + reload"
remote "rm -f ${INCOMING_REL}"
remote "pm2 reload $DEPLOY_PM2_NAME"

echo "sync-content: done"
```

- [ ] **Step 2: Create the orchestrator `deploy.sh`**

Create `scripts/deploy/deploy.sh`:

```bash
#!/usr/bin/env bash
# Full deploy: gate -> migrate -> deploy-code -> sync-content. Aborts on the
# first failure. Forwards --dry-run to every stage.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARGS="$*"

echo "deploy: [1/4] gate"
bash "$DIR/gate.sh"
echo "deploy: [2/4] migrate"
bash "$DIR/migrate.sh" $ARGS
echo "deploy: [3/4] deploy-code"
bash "$DIR/deploy-code.sh" $ARGS
echo "deploy: [4/4] sync-content"
bash "$DIR/sync-content.sh" $ARGS
echo "deploy: complete"
```

- [ ] **Step 3: Add npm scripts**

Modify the `scripts` block of root `package.json` to add the five entries (keep existing scripts unchanged):

```json
    "deploy": "bash scripts/deploy/deploy.sh",
    "deploy:gate": "bash scripts/deploy/gate.sh",
    "deploy:migrate": "bash scripts/deploy/migrate.sh",
    "deploy:code": "bash scripts/deploy/deploy-code.sh",
    "deploy:sync-content": "bash scripts/deploy/sync-content.sh",
```

- [ ] **Step 4: Make executable and dry-run the full orchestrator**

```bash
chmod +x scripts/deploy/sync-content.sh scripts/deploy/deploy.sh
```

A full `deploy --dry-run` would run the real gate (which requires a clean tree, and these files are uncommitted). So dry-run only the remote stages here, then commit, then dry-run the orchestrator:

Run: `bash scripts/deploy/sync-content.sh --dry-run`
Expected: `DRY local>` / `DRY rsync>` / `DRY remote>` lines for snapshot, ship, backup, merge, cleanup, reload; exit 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/deploy/sync-content.sh scripts/deploy/deploy.sh package.json
```
```bash
git commit -m "$(cat <<'EOF'
feat(deploy): sync-content stage, orchestrator, and npm scripts

sync-content.sh snapshots the local DB, ships it, backs up prod, runs syncMerge,
and reloads. deploy.sh chains gate->migrate->deploy-code->sync-content. Adds
npm run deploy[:gate|:migrate|:code|:sync-content].

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017HvawEEAoQzxnBfWMgpPsK
EOF
)"
```

- [ ] **Step 6: Dry-run the full pipeline on the now-clean tree**

Run: `npm run deploy -- --dry-run`
Expected: gate runs for real and prints `gate: PASS`; migrate/deploy-code/sync-content print their `DRY` lines; ends with `deploy: complete`, exit 0.

---

### Task 7: One-time rollout + skill update (operational runbook)

Not a TDD task — this is the one-time adoption against the real DBs and the deploy-skill update. Run these deliberately, in order. The prod steps mutate the live DB; each is preceded by a backup in the scripts, but proceed carefully.

**Files:**
- Modify: `.claude/skills/deploy-localfinds/SKILL.md` (gitignored — invoke the new scripts)

- [ ] **Step 1: Baseline-adopt the LOCAL DB**

The local DB already has the full schema (from earlier `push`). Mark the baseline applied so `migrate` won't try to recreate tables:

Run: `cd packages/db && npx tsx src/adopt-migrations.ts`
Expected: `adopted: marked=[0000_...] skipped=[]`.

Verify a subsequent local migrate is a no-op:
Run: `cd packages/db && npx tsx src/migrate.ts`
Expected: `migrations applied` with no errors and no table changes (data intact — confirm with `sqlite3 ../../data/localfinds.db "SELECT COUNT(*) FROM finds;"`).

- [ ] **Step 2: Converge PROD to the baseline schema (final-ever `push`)**

Prod is one change behind (missing `fetches` + `sources.ical_url`). Bring it current with the last manual push, then it will match `0000`. This is the standing handoff item.

Hand the user (or run via the deploy SSH) on prod, in `$DEPLOY_PATH`, with the nvm prefix:
Run (on prod): `npm run db:push -w @localfinds/db` (watch for and accept the additive changes: create `fetches`, add `sources.ical_url`; existing data intact).
Expected: push reports the additive changes applied; `sqlite3 data/localfinds.db "SELECT COUNT(*) FROM finds;"` unchanged from before.

- [ ] **Step 3: Baseline-adopt the PROD DB**

Now prod's schema matches `0000`; mark it applied so future `migrate` only runs genuinely new migrations:

Run (on prod, in `$DEPLOY_PATH`, nvm prefix): `npx tsx packages/db/src/adopt-migrations.ts`
Expected: `adopted: marked=[0000_...] skipped=[]`.

- [ ] **Step 4: Update the deploy skill to invoke the pipeline**

Edit `.claude/skills/deploy-localfinds/SKILL.md` (gitignored): replace the inline `redeploy`/`sync-data` command blocks with the new entry points, keeping the infra facts table and troubleshooting sections. New body for those sections:

```markdown
## redeploy (code + schema + content)

From the dev machine (repo root). Requires `data/config/deploy.env` (gitignored).

    npm run deploy            # gate → migrate → deploy-code → sync-content
    npm run deploy -- --dry-run   # preview every remote action, mutate nothing

Individual stages: `npm run deploy:gate | deploy:migrate | deploy:code | deploy:sync-content`.

## sync-data (refresh content only, after an agent run)

    npm run deploy:sync-content

Merges local discovery data into prod, preserving prod-side feedback and
finds.status (stars/hides). Prod DB is backed up first
(`data/localfinds.db.bak-<stamp>`).

## Schema changes

Edit `packages/db/src/schema.ts`, then `cd packages/db && npx drizzle-kit
generate`, review + commit the new `drizzle/NNNN_*.sql`. `npm run deploy`
applies it via the migrate stage. **Never run `drizzle-kit push` again** — the
one-time baseline adoption is complete.
```

- [ ] **Step 5: First real content sync (validation)**

With local + prod both adopted, run a real content sync and confirm the live site is intact:

Run: `npm run deploy:sync-content`
Expected: completes; `curl -sS -o /dev/null -w "%{http_code}\n" https://localfinds.peaslee.org/` → 200. Spot-check that any pre-existing prod stars/hides survived (they must, by design).

- [ ] **Step 6: Note completion**

No commit needed (the only changed file, the skill, is gitignored). The pipeline is live; `main` remains local-only unless you choose to push to `origin` separately.

---

## Notes for the implementer

- **tsx on prod:** `migrate.sh` and `sync-content.sh` run `npx tsx ...` on the server. `tsx` and `drizzle-kit` are devDependencies of `packages/db`; the deploy's `npm ci` installs devDependencies (default), so they are present. If a future change sets `NODE_ENV=production` or `--omit=dev` for the server install, add `tsx` access explicitly.
- **`sqlite3` CLI on prod:** the backup steps use the `sqlite3` binary (already used by the current deploy skill's snapshot step), so it is present on the server.
- **Deletes don't propagate** (documented limitation): a find/source removed locally stays on prod. Out of scope here.
- **Order matters in `syncMerge`:** sources before finds (FK remap), runs before fetches (FK). The single transaction keeps it atomic; the pre-sync prod backup is the rollback.
