# Interview Depth Dial + Refine Cycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the interviewer's fixed two-phase flow (collect → synthesize) into a depth-dialled, looped `convo → build → run → review` cycle, where each cycle runs a small live prospector pass and a review phase feeds findings back into the next conversation — the loop that produced the best ICP results by hand.

**Architecture:** A new orchestration loop in `interview.ts` runs N preliminary cycles (N = 0/1/2 for brief/medium/comprehensive) plus one final cycle. Each cycle: a live conversation (`convo`), a config synthesis that writes to a **staging dir** (`build`), a small capped prospector run reading staging config and writing **provisional** leads to the real DB (`run`), and a read-only `review` that reports and emits `probes` seeding the next `convo`. Nothing touches live config or the visible feed until the user confirms at the end: staging is promoted to real and provisional leads flip to `new`; on reject, staging is deleted and provisional leads dropped.

**Tech Stack:** TypeScript (ESM, `tsx`), `@anthropic-ai/claude-agent-sdk` (`query`, `createSdkMcpServer`, `tool`), Drizzle ORM over SQLite, Zod, Vitest. Monorepo: `@localfinds/db` (schema/config/queries), `@localfinds/agents` (agents, interviewer, runner).

## Global Constraints

- **Isolation model (locked):** config + ICP profile write to a **staging dir**; leads write to the **real DB** tagged `status:"provisional"` and excluded from every user-facing view until promoted. The DB path must stay on `dataDir()` (never moved by the config-dir override).
- **Run source (locked):** the run phase uses today's local directory via `list_businesses`. The bespoke AWS API is a later drop-in at that tool; **do not** build against it now.
- **Single write-path invariant:** only `build` writes config; `review` is strictly read-only (no `set_*`, no DB writes except none).
- **`convo` effort is constant** (`INTERVIEWER_COLLECTION_EFFORT`, medium) every cycle. The dial only changes `build`/`review` effort and the cycle count.
- **Dead-air minimisation:** the run phase is always capped small (`maxTurns: 8`, `effort: "low"`) and streamed live through the existing `logMessage`.
- **PII / public repo:** all of `data/` is gitignored; never commit `data/**`. Plan doc itself is fine to commit.
- **Commits:** `git add` and `git commit` are separate Bash calls (never combined). Commit message trailer is added automatically by the harness — write a normal Conventional-Commits subject + body.
- **SQLite text enums in Drizzle are TS-level only** (no SQL CHECK constraint), so adding an enum value is a TypeScript change; `npm run db:push` should report no schema change.

---

### Task 1: `provisional` find status — schema, helpers, view exclusion

Adds the `provisional` lead state and the promote/discard/list helpers. A provisional find must be invisible in every user-facing query until promoted.

**Files:**
- Modify: `packages/db/src/schema.ts:42` (finds.status enum)
- Modify: `packages/db/src/queries.ts` (FindStatus type ~297; `feedConditions` ~162; `listActiveTags` ~257; `listFindTypes` ~271; add helpers)
- Test: `packages/db/src/queries.test.ts`

**Interfaces:**
- Produces: `type FindStatus = "new" | "shown" | "hidden" | "starred" | "provisional"`; `listProvisionalFinds(): Find[]`; `promoteProvisionalFinds(): number` (sets every `provisional` → `new`, returns count); `discardProvisionalFinds(): number` (deletes every `provisional`, returns count).

- [ ] **Step 1: Write the failing test**

Add to `packages/db/src/queries.test.ts` (follow the existing in-memory DB setup used by the other tests in this file — reuse the same `beforeEach`/helper that seeds a fresh DB; if a helper like `seedFind`/`insertFind` is already imported there, use it):

```ts
import {
  insertFind,
  getFeed,
  listActiveTags,
  listFindTypes,
  listProvisionalFinds,
  promoteProvisionalFinds,
  discardProvisionalFinds,
} from "./queries";

describe("provisional finds", () => {
  it("are hidden from every user-facing view but listable directly", () => {
    insertFind({ title: "Visible Lead", type: "lead", agent: "prospector", tags: ["maker"] });
    insertFind({
      title: "Provisional Lead",
      type: "lead",
      agent: "prospector",
      tags: ["provisional-tag"],
      status: "provisional",
    });

    const feedTitles = getFeed({}).items.map((f) => f.title);
    expect(feedTitles).toContain("Visible Lead");
    expect(feedTitles).not.toContain("Provisional Lead");
    expect(listActiveTags()).not.toContain("provisional-tag");
    expect(listFindTypes()).toContain("lead"); // from the visible lead only

    expect(listProvisionalFinds().map((f) => f.title)).toEqual(["Provisional Lead"]);
  });

  it("promote flips provisional → new; discard deletes them", () => {
    insertFind({ title: "P1", type: "lead", agent: "prospector", status: "provisional" });
    insertFind({ title: "P2", type: "lead", agent: "prospector", status: "provisional" });

    expect(promoteProvisionalFinds()).toBe(2);
    expect(listProvisionalFinds()).toHaveLength(0);
    expect(getFeed({}).items.map((f) => f.title)).toEqual(expect.arrayContaining(["P1", "P2"]));

    insertFind({ title: "P3", type: "lead", agent: "prospector", status: "provisional" });
    expect(discardProvisionalFinds()).toBe(1);
    expect(listProvisionalFinds()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm -w @localfinds/db run test -- queries.test.ts -t "provisional"`
Expected: FAIL — `status` not assignable on `insertFind` input, and `listProvisionalFinds`/`promoteProvisionalFinds`/`discardProvisionalFinds` are not exported.

- [ ] **Step 3: Add the enum value (schema.ts:42)**

```ts
  status: text("status", { enum: ["new", "shown", "hidden", "starred", "provisional"] })
    .notNull()
    .default("new"),
```

- [ ] **Step 4: Extend `FindStatus` and add provisional exclusion + helpers (queries.ts)**

Update the type (~line 297):

```ts
export type FindStatus = "new" | "shown" | "hidden" | "starred" | "provisional";
```

In `feedConditions` (~162), exclude provisional from the user-facing views (`default` and `starred`). Add a shared predicate next to `notExpired()` and use it:

```ts
// Provisional leads belong to an in-progress interview's sample run and must
// never surface in the feed until promoted to "new".
function notProvisional() {
  return ne(finds.status, "provisional");
}
```

Then in `feedConditions`:

```ts
  if (view === "default") {
    conditions.push(ne(finds.status, "hidden"), notProvisional(), notExpired());
  }
  if (view === "starred") {
    conditions.push(eq(finds.status, "starred"), notExpired());
  }
  if (view === "hidden") conditions.push(eq(finds.status, "hidden"));
```

(`starred`/`hidden` already exclude provisional because they match a specific status; only `default` needs the extra clause. The `all` view — if reached — is interview tooling, not the public feed; leave it.)

In `listActiveTags` (~257) and `listFindTypes` (~271), the raw SQL filters on `status != 'hidden'` — add provisional:

```ts
        where ${finds.status} not in ('hidden', 'provisional') and (${finds.expiresAt} is null or ${finds.expiresAt} >= ${today})
```

(apply the same `not in ('hidden', 'provisional')` change to BOTH queries; `listActiveTags` uses `new Date().toISOString().slice(0, 10)` inline — keep its existing date expression, only change the status clause.)

Add the three helpers (near `updateFindStatuses`, ~328). `Find` and `finds` are already imported in this file:

```ts
export function listProvisionalFinds(): Find[] {
  return db().select().from(finds).where(eq(finds.status, "provisional")).all() as Find[];
}

export function promoteProvisionalFinds(): number {
  return db()
    .update(finds)
    .set({ status: "new" })
    .where(eq(finds.status, "provisional"))
    .run().changes;
}

export function discardProvisionalFinds(): number {
  return db().delete(finds).where(eq(finds.status, "provisional")).run().changes;
}
```

- [ ] **Step 5: Allow `insertFind` to set status (queries.ts)**

Find the `NewFindInput` interface (the input type of `insertFind`, near line 66) and add:

```ts
  /** Defaults to "new". Set "provisional" for an interview sample run's leads. */
  status?: FindStatus;
```

In the `insertFind` `.values({ ... })` object, add `status` (the column currently relies on the DB default):

```ts
      status: input.status ?? "new",
```

- [ ] **Step 6: Run tests + db:push check**

Run: `npm -w @localfinds/db run test -- queries.test.ts -t "provisional"`
Expected: PASS (both tests).

Run: `npm run db:push`
Expected: drizzle-kit reports no schema change (SQLite text enum is TS-level). If it offers a statement, inspect it — it should be a no-op or an empty diff; do **not** drop/recreate the table.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/schema.ts packages/db/src/queries.ts packages/db/src/queries.test.ts
```
```bash
git commit -m "feat(db): provisional find status + promote/discard helpers

Leads from an in-progress interview sample run are tagged provisional and
excluded from every user-facing feed/tag/type view until promoted."
```

---

### Task 2: `save_find` writes provisional when the run requests it

Lets the interviewer's sample prospector run stamp its leads `provisional` without changing the public `save_find` contract — the override flows from the server factory.

**Files:**
- Modify: `packages/agents/src/mcp-tools.ts:140` (`buildLocalfindsServer` signature + the `save_find` handler ~187)
- Test: `packages/agents/src/mcp-tools.test.ts` (create if absent; otherwise add to the existing file)

**Interfaces:**
- Consumes: `insertFind({ ..., status })` from Task 1; `FindStatus` from `@localfinds/db`.
- Produces: `buildLocalfindsServer(agent: string, counters: RunCounters, opts?: { findStatusOverride?: FindStatus })`. When `findStatusOverride` is set, every `save_find` insert uses that status.

- [ ] **Step 1: Write the failing test**

Create/append `packages/agents/src/mcp-tools.test.ts`. The SDK MCP tools aren't trivially invokable in isolation, so test the *seam* — extract the insert status decision into a tiny pure helper and test that, then wire the handler to it.

```ts
import { describe, it, expect } from "vitest";
import { resolveFindStatus } from "./mcp-tools";

describe("resolveFindStatus", () => {
  it("defaults to undefined (insertFind will use 'new')", () => {
    expect(resolveFindStatus(undefined)).toBeUndefined();
  });
  it("returns the override when set", () => {
    expect(resolveFindStatus("provisional")).toBe("provisional");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm -w @localfinds/agents run test -- mcp-tools.test.ts`
Expected: FAIL — `resolveFindStatus` is not exported.

- [ ] **Step 3: Implement the helper + thread the option (mcp-tools.ts)**

Add the import for the type (alongside the existing `insertFind` import from `@localfinds/db`):

```ts
import { insertFind, type FindStatus } from "@localfinds/db";
```

Add the pure helper near the top of the file (exported):

```ts
// The status a save_find insert should use. undefined → insertFind defaults to
// "new". An interview sample run passes "provisional" so its leads stay out of
// the feed until the interview is confirmed.
export function resolveFindStatus(override: FindStatus | undefined): FindStatus | undefined {
  return override;
}
```

Change the factory signature (line 140):

```ts
export function buildLocalfindsServer(
  agent: string,
  counters: RunCounters,
  opts: { findStatusOverride?: FindStatus } = {},
) {
```

In the `save_find` handler, pass the resolved status into `insertFind` (the `.insertFind({ ... })` call ~187):

```ts
          const result = insertFind({
            title: args.title,
            url: args.url,
            summary: args.summary,
            eventStart: args.event_start,
            eventEnd: args.event_end,
            expiresAt: args.expires_at,
            publishedAt: args.published_at,
            tags: args.tags,
            sourceUrl: args.source_url,
            type: args.type,
            businessId: args.business_id,
            score: args.score,
            agent,
            status: resolveFindStatus(opts.findStatusOverride),
          });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm -w @localfinds/agents run test -- mcp-tools.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/mcp-tools.ts packages/agents/src/mcp-tools.test.ts
```
```bash
git commit -m "feat(agents): save_find can stamp provisional via server option

buildLocalfindsServer accepts findStatusOverride so an interview sample run's
leads are written provisional; default behavior (new) is unchanged."
```

---

### Task 3: Config-dir staging override

Lets the interviewer point config + ICP writes/reads at a staging directory while the DB stays on the real `dataDir()`. One override switch; the four interviewer-written artifacts resolve through it.

**Files:**
- Modify: `packages/db/src/paths.ts` (add `setConfigDirOverride` / `configDir`)
- Modify: `packages/db/src/config.ts` (`regionConfigPath`, `categoryConfigPath`, `townsConfigPath`, `icpProfilePath`, and `writeIcpProfile`'s workspace dir use `configDir()` instead of `dataDir()` / `agentWorkspaceDir("prospector")`)
- Test: `packages/db/src/config.test.ts`

**Interfaces:**
- Produces: `setConfigDirOverride(dir: string | undefined): void` and `configDir(): string` (returns the override if set, else `dataDir()`). The override affects ONLY the four interviewer config artifacts; `dbPath()`, `agentWorkspaceDir`, town-boundaries and map-categories paths stay on `dataDir()`.

- [ ] **Step 1: Write the failing test**

Add to `packages/db/src/config.test.ts` (this file already imports the config writers and `agentWorkspaceDir`; mirror its temp-dir pattern):

```ts
import { setConfigDirOverride, configDir, dbPath } from "./paths";

describe("config-dir staging override", () => {
  afterEach(() => setConfigDirOverride(undefined));

  it("routes config + ICP writes to the override dir, leaving the DB path alone", () => {
    const realDb = dbPath();
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), "lf-staging-"));
    setConfigDirOverride(staging);

    writeRegionConfig({ name: "Testville, Maine", coverageMarkdown: "Coverage." });
    writeIcpProfile("# Staged ICP\n");

    expect(fs.existsSync(path.join(staging, "config", "region.md"))).toBe(true);
    expect(fs.existsSync(path.join(staging, "agents", "prospector", "profile.md"))).toBe(true);
    expect(readRegionConfig()?.name).toBe("Testville, Maine");
    expect(readIcpProfile()).toBe("# Staged ICP\n");

    // The DB path must NOT move with the config override.
    expect(dbPath()).toBe(realDb);

    setConfigDirOverride(undefined);
    // Back to the real dir → the staged region is no longer what we read.
    expect(readRegionConfig()?.name).not.toBe("Testville, Maine");
  });
});
```

(Ensure `os`, `path`, `fs` are imported at the top of the test file — add any that are missing.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm -w @localfinds/db run test -- config.test.ts -t "staging override"`
Expected: FAIL — `setConfigDirOverride` / `configDir` not exported.

- [ ] **Step 3: Add the override in paths.ts**

After the `dataDir()` definition in `packages/db/src/paths.ts`:

```ts
// An optional override used by the interviewer to stage config + ICP writes in a
// scratch directory until the user confirms. It deliberately does NOT affect
// dbPath() or agentWorkspaceDir — leads still go to the real DB and agent run
// logs to the real workspace. Single-threaded, sequential use only.
let configDirOverride: string | undefined;

export function setConfigDirOverride(dir: string | undefined): void {
  configDirOverride = dir;
}

export function configDir(): string {
  return configDirOverride ?? dataDir();
}
```

- [ ] **Step 4: Point the four interviewer artifacts at `configDir()` (config.ts)**

Update the import (line 3) to add `configDir`:

```ts
import { agentWorkspaceDir, configDir, dataDir } from "./paths";
```

Change these path functions from `dataDir()` to `configDir()`:

```ts
export function regionConfigPath(): string {
  return path.join(configDir(), "config", "region.md");
}
```
```ts
export function categoryConfigPath(): string {
  return path.join(configDir(), "config", "categories.json");
}
```
```ts
export function townsConfigPath(): string {
  return path.join(configDir(), "config", "towns.json");
}
```

For the ICP, switch off `agentWorkspaceDir("prospector")` so the override applies (when unset, `configDir()` === `dataDir()`, so the real path is byte-identical to today):

```ts
export function icpProfilePath(): string {
  return path.join(configDir(), "agents", "prospector", "profile.md");
}
```

And in `writeIcpProfile`, derive the workspace from `configDir()` too:

```ts
export function writeIcpProfile(markdown: string): void {
  const workspace = path.join(configDir(), "agents", "prospector");
  fs.mkdirSync(path.join(workspace, "notes"), { recursive: true });
  fs.writeFileSync(icpProfilePath(), markdown);
}
```

Leave `townBoundariesPath`, `mapCategoriesPath`, and every other `dataDir()`/`agentWorkspaceDir` caller unchanged.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm -w @localfinds/db run test -- config.test.ts`
Expected: PASS (the new test and all existing config tests — the override defaults to unset, so existing behavior is unchanged).

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/paths.ts packages/db/src/config.ts packages/db/src/config.test.ts
```
```bash
git commit -m "feat(db): config-dir staging override for the interviewer

setConfigDirOverride redirects the region/towns/categories/ICP paths to a
scratch dir; dbPath and agent workspaces stay on the real data dir."
```

---

### Task 4: `runAgent` overrides — effort, workspaceDir, findStatusOverride

Gives the runner the three knobs the sample run needs. Keeps all existing callers (the scheduler) behaving exactly as before.

**Files:**
- Modify: `packages/agents/src/run-agent.ts` (`RunOptions` ~76; `ensureWorkspace` ~104; the `query` options ~205-235)
- Test: `packages/agents/src/run-agent.test.ts` (create if absent)

**Interfaces:**
- Consumes: `buildLocalfindsServer(agent, counters, { findStatusOverride })` from Task 2.
- Produces: `RunOptions` gains `effort?: ReasoningEffort`, `workspaceDir?: string`, `findStatusOverride?: FindStatus`. `ensureWorkspace(dir: string): string` now takes an explicit directory. Behavior: `effort` overrides `def.effort`; `workspaceDir` overrides the agent's workspace (profile read + cwd + path guard + run note); `findStatusOverride` flows to the MCP server.

- [ ] **Step 1: Write the failing test**

`ensureWorkspace` is the unit-testable piece. Create `packages/agents/src/run-agent.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureWorkspace } from "./run-agent";

describe("ensureWorkspace(dir)", () => {
  it("creates notes/ and seeds a profile.md at the GIVEN dir", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lf-ws-"));
    const out = ensureWorkspace(dir);
    expect(out).toBe(dir);
    expect(fs.existsSync(path.join(dir, "notes"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "profile.md"))).toBe(true);
  });

  it("does not clobber an existing profile.md", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lf-ws-"));
    fs.writeFileSync(path.join(dir, "profile.md"), "# Mine\n");
    ensureWorkspace(dir);
    expect(fs.readFileSync(path.join(dir, "profile.md"), "utf8")).toBe("# Mine\n");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm -w @localfinds/agents run test -- run-agent.test.ts`
Expected: FAIL — `ensureWorkspace` is not exported / takes a name, not a dir.

- [ ] **Step 3: Refactor `ensureWorkspace` to take a dir + export it (run-agent.ts)**

Replace the `ensureWorkspace` function (~104):

```ts
export function ensureWorkspace(workspace: string): string {
  fs.mkdirSync(path.join(workspace, "notes"), { recursive: true });
  const profilePath = path.join(workspace, "profile.md");
  if (!fs.existsSync(profilePath)) {
    const example = `${profilePath}.example`;
    if (fs.existsSync(example)) {
      fs.copyFileSync(example, profilePath);
    } else {
      fs.writeFileSync(profilePath, `# profile\n`);
    }
  }
  return workspace;
}
```

Update its caller inside `runAgent` (where `const workspace = ensureWorkspace(def.name);` was) to resolve the dir and honor the override:

```ts
  const workspace = ensureWorkspace(opts.workspaceDir ?? agentWorkspaceDir(def.name));
```

(`agentWorkspaceDir` is already imported in run-agent.ts; if not, add it to the `@localfinds/db` import.)

- [ ] **Step 4: Extend `RunOptions` and thread effort + status (run-agent.ts)**

Add the import for the status type to the `@localfinds/db` import line:

```ts
import { /* ...existing..., */ type FindStatus } from "@localfinds/db";
```

Extend `RunOptions` (~76):

```ts
export interface RunOptions {
  maxTurns?: number;
  maxBudgetUsd?: number;
  /** Appended to the task prompt — used for dev/test runs. */
  extraPrompt?: string;
  /** Override the agent's reasoning effort (interview sample runs use "low"). */
  effort?: ReasoningEffort;
  /** Run in this workspace dir instead of the agent's default (interview staging). */
  workspaceDir?: string;
  /** Stamp save_find inserts with this status (interview runs pass "provisional"). */
  findStatusOverride?: FindStatus;
}
```

In the `query({ options: { ... } })` block, change the effort line and the MCP server line:

```ts
        effort: opts.effort ?? def.effort,
```
```ts
        mcpServers: {
          localfinds: buildLocalfindsServer(def.name, counters, {
            findStatusOverride: opts.findStatusOverride,
          }),
        },
```

(The `cwd: workspace`, `workspaceSystemNote(workspace)`, and `makePathGuard(workspace)` lines already use the local `workspace` variable, so they pick up the override automatically.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm -w @localfinds/agents run test -- run-agent.test.ts`
Expected: PASS.

Run: `npm -w @localfinds/agents run test`
Expected: PASS (no regressions in the wider agents suite).

- [ ] **Step 6: Commit**

```bash
git add packages/agents/src/run-agent.ts packages/agents/src/run-agent.test.ts
```
```bash
git commit -m "feat(agents): runAgent effort/workspaceDir/findStatusOverride options

Enables a small, isolated, provisional-writing sample run for the interviewer
while leaving scheduled runs unchanged."
```

---

### Task 5: Interview staging helpers

A small module that creates, seeds, promotes, and discards the staging directory. Pure filesystem; fully unit-testable.

**Files:**
- Create: `packages/agents/src/interview-staging.ts`
- Test: `packages/agents/src/interview-staging.test.ts`

**Interfaces:**
- Produces:
  - `createStagingDir(realDataDir: string, runId: string): string` — makes (and returns) `<realDataDir>/.staging-<runId>/`, mirroring the real layout (`config/`, `agents/prospector/notes/`).
  - `seedStaging(realDataDir: string, stagingDir: string): void` — copies the current `config/region.md`, `config/towns.json`, `config/categories.json`, and `agents/prospector/profile.md` (each only if it exists) into the staging dir so `build` edits rather than starts blank.
  - `promoteStaging(realDataDir: string, stagingDir: string): string[]` — copies the four staged artifacts back over the real ones; returns the list of real paths written.
  - `discardStaging(stagingDir: string): void` — `rm -rf` the staging dir.
- Consumed by Task 10 (the orchestration loop).

- [ ] **Step 1: Write the failing test**

Create `packages/agents/src/interview-staging.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createStagingDir,
  seedStaging,
  promoteStaging,
  discardStaging,
} from "./interview-staging";

function realDirWith(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lf-real-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return root;
}

describe("interview staging", () => {
  it("creates a mirrored staging dir and seeds existing config", () => {
    const real = realDirWith({
      "config/region.md": "REGION",
      "config/towns.json": "{}",
      "agents/prospector/profile.md": "OLD ICP",
    });
    const staging = createStagingDir(real, "run1");
    expect(staging).toBe(path.join(real, ".staging-run1"));

    seedStaging(real, staging);
    expect(fs.readFileSync(path.join(staging, "config/region.md"), "utf8")).toBe("REGION");
    expect(fs.readFileSync(path.join(staging, "agents/prospector/profile.md"), "utf8")).toBe("OLD ICP");
    // categories.json didn't exist in real → not seeded, no throw.
    expect(fs.existsSync(path.join(staging, "config/categories.json"))).toBe(false);
  });

  it("promotes staged artifacts over the real ones and discards cleanly", () => {
    const real = realDirWith({ "config/region.md": "OLD" });
    const staging = createStagingDir(real, "run2");
    fs.mkdirSync(path.join(staging, "config"), { recursive: true });
    fs.mkdirSync(path.join(staging, "agents/prospector"), { recursive: true });
    fs.writeFileSync(path.join(staging, "config/region.md"), "NEW");
    fs.writeFileSync(path.join(staging, "agents/prospector/profile.md"), "NEW ICP");

    const written = promoteStaging(real, staging);
    expect(fs.readFileSync(path.join(real, "config/region.md"), "utf8")).toBe("NEW");
    expect(fs.readFileSync(path.join(real, "agents/prospector/profile.md"), "utf8")).toBe("NEW ICP");
    expect(written).toContain(path.join(real, "config/region.md"));

    discardStaging(staging);
    expect(fs.existsSync(staging)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm -w @localfinds/agents run test -- interview-staging.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

Create `packages/agents/src/interview-staging.ts`:

```ts
// Staging for the interview cycle: build writes config + ICP here, the sample
// run reads from here, and only on the user's final confirm do we promote these
// four artifacts over the real ones. A reject is a plain rm -rf — the live config
// is never touched mid-interview, so a crash can't corrupt it.

import fs from "node:fs";
import path from "node:path";

// The four interviewer-written artifacts, as paths relative to the data dir.
const STAGED_ARTIFACTS = [
  "config/region.md",
  "config/towns.json",
  "config/categories.json",
  "agents/prospector/profile.md",
];

export function createStagingDir(realDataDir: string, runId: string): string {
  const staging = path.join(realDataDir, `.staging-${runId}`);
  fs.mkdirSync(path.join(staging, "config"), { recursive: true });
  fs.mkdirSync(path.join(staging, "agents", "prospector", "notes"), { recursive: true });
  return staging;
}

export function seedStaging(realDataDir: string, stagingDir: string): void {
  for (const rel of STAGED_ARTIFACTS) {
    const src = path.join(realDataDir, rel);
    if (!fs.existsSync(src)) continue; // cold start — nothing to seed
    const dest = path.join(stagingDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

export function promoteStaging(realDataDir: string, stagingDir: string): string[] {
  const written: string[] = [];
  for (const rel of STAGED_ARTIFACTS) {
    const src = path.join(stagingDir, rel);
    if (!fs.existsSync(src)) continue; // build didn't write this one
    const dest = path.join(realDataDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    written.push(dest);
  }
  return written;
}

export function discardStaging(stagingDir: string): void {
  fs.rmSync(stagingDir, { recursive: true, force: true });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm -w @localfinds/agents run test -- interview-staging.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/interview-staging.ts packages/agents/src/interview-staging.test.ts
```
```bash
git commit -m "feat(agents): interview staging dir create/seed/promote/discard"
```

---

### Task 6: `runProspectorSample` — the runAgent bridge

Runs a small, capped, provisional-writing prospector pass against staging config, streamed live. This is where the interviewer first imports `runAgent`.

**Files:**
- Modify: `packages/agents/src/interview.ts` (add `runProspectorSample` + a pure `sampleRunOptions` helper; import `runAgent`, `prospector`, `setConfigDirOverride`)
- Test: `packages/agents/src/interview.test.ts` (test the pure `sampleRunOptions`)

**Interfaces:**
- Consumes: `runAgent(prospector, RunOptions)` (Tasks 2/4), `setConfigDirOverride` (Task 3).
- Produces:
  - `sampleRunOptions(stagingDir: string): RunOptions` — pure: `{ maxTurns: 8, effort: "low", workspaceDir: <stagingDir>/agents/prospector, findStatusOverride: "provisional" }`.
  - `runProspectorSample(stagingDir: string): Promise<{ runId: number; status: string }>` — sets the config-dir override to `stagingDir` for the duration, runs the prospector, streams via `logMessage`, restores the override in `finally`, returns the run id + status.

- [ ] **Step 1: Write the failing test**

Add to `packages/agents/src/interview.test.ts` (it already imports pure helpers from `./interview`):

```ts
import { sampleRunOptions } from "./interview";

describe("sampleRunOptions", () => {
  it("is small, low-effort, provisional, and points at the staging prospector workspace", () => {
    const opts = sampleRunOptions("/data/.staging-x");
    expect(opts.maxTurns).toBe(8);
    expect(opts.effort).toBe("low");
    expect(opts.findStatusOverride).toBe("provisional");
    expect(opts.workspaceDir).toBe("/data/.staging-x/agents/prospector");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm -w @localfinds/agents run test -- interview.test.ts -t "sampleRunOptions"`
Expected: FAIL — `sampleRunOptions` is not exported.

- [ ] **Step 3: Implement the bridge (interview.ts)**

Add imports near the top of `interview.ts`:

```ts
import path from "node:path";
import { runAgent, type RunOptions } from "./run-agent";
import { prospector } from "./agents/prospector";
import { setConfigDirOverride } from "@localfinds/db";
```

(If `path` is already imported, don't duplicate it.)

Add the pure helper + the runner (place them with the other module-level functions):

```ts
// A deliberately tiny prospector pass for the interview loop: one quick capped
// run (runAgent's maxTurns<=10 path already caps it to ~2 fetches / ~3 saves),
// low effort, reading the staged ICP and writing provisional leads to the real DB.
export function sampleRunOptions(stagingDir: string): RunOptions {
  return {
    maxTurns: 8,
    effort: "low",
    workspaceDir: path.join(stagingDir, "agents", "prospector"),
    findStatusOverride: "provisional",
  };
}

// Run the sample pass with config reads pointed at staging. The DB stays real
// (provisional leads land in the real finds table), so we override only the
// config dir, and always restore it.
async function runProspectorSample(
  stagingDir: string,
): Promise<{ runId: number; status: string }> {
  process.stdout.write("\nRunning a quick prospector pass against this profile…\n");
  setConfigDirOverride(stagingDir);
  try {
    const { runId, result } = await runAgent(prospector, sampleRunOptions(stagingDir));
    return { runId, status: result?.subtype ?? "error" };
  } finally {
    setConfigDirOverride(undefined);
  }
}
```

Note: `runAgent` already streams every message through its own `logMessage`, so the run is watchable with no extra wiring. `setConfigDirOverride` must be re-exported from `@localfinds/db` — confirm it's in that package's public `index.ts`; if not, add `export * from "./paths"` coverage or an explicit re-export of `setConfigDirOverride`/`configDir`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm -w @localfinds/agents run test -- interview.test.ts -t "sampleRunOptions"`
Expected: PASS.

- [ ] **Step 5: Verify the db export resolves**

Run: `npm -w @localfinds/agents run test`
Expected: PASS, and no "setConfigDirOverride is not exported from @localfinds/db" type error. If it errors, add the re-export to `packages/db/src/index.ts` and re-run.

- [ ] **Step 6: Commit**

```bash
git add packages/agents/src/interview.ts packages/agents/src/interview.test.ts packages/db/src/index.ts
```
```bash
git commit -m "feat(agents): runProspectorSample — small provisional sample run

A capped low-effort prospector pass reading staged config, streamed live; leads
land provisional in the real DB. Config-dir override restored in finally."
```

---

### Task 7: Review tools + types (`read_run_results`, `submit_review`)

Adds the review phase's read-only tools and the structured result it returns. The leads come from the real DB (provisional); the narrative comes from the staged prospector's `coverage.md`.

**Files:**
- Modify: `packages/agents/src/interview-tools.ts` (add types, `buildReviewServer`)
- Test: `packages/agents/src/interview-tools.test.ts`

**Interfaces:**
- Consumes: `listProvisionalFinds()` (Task 1); `currentConfig()` (existing).
- Produces:
  - `interface ReviewProbe { topic: string; observation: string; askUser: string }`
  - `interface ReviewResult { report: string; calibration: string; probes: ReviewProbe[] }`
  - `interface ReviewSink { value?: ReviewResult }`
  - `interface ReviewContext { runId: number; scratchDir: string }`
  - `buildReviewServer(io: InterviewIO, ctx: ReviewContext, sink: ReviewSink)` — an MCP server exposing `say`, `read_current_config`, `read_run_results`, `submit_review`.
  - `reviewRunResults(ctx: ReviewContext)` — pure-ish reader returning `{ runId, leads, coverageNote }` (exported for the test).

- [ ] **Step 1: Write the failing test**

Add to `packages/agents/src/interview-tools.test.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { reviewRunResults } from "./interview-tools";
import { insertFind } from "@localfinds/db";

describe("reviewRunResults", () => {
  it("returns provisional leads and the scratch coverage note", () => {
    insertFind({
      title: "Provisional Co",
      type: "lead",
      agent: "prospector",
      score: 0.7,
      tags: ["maker"],
      status: "provisional",
    });
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lf-scratch-"));
    fs.mkdirSync(path.join(scratch, "notes"), { recursive: true });
    fs.writeFileSync(path.join(scratch, "notes", "coverage.md"), "Walked Rockland. Skipped X.");

    const out = reviewRunResults({ runId: 42, scratchDir: scratch });
    expect(out.runId).toBe(42);
    expect(out.leads.map((l) => l.title)).toContain("Provisional Co");
    expect(out.coverageNote).toContain("Skipped X");
  });
});
```

(Use the same in-memory-DB `beforeEach` the rest of this test file uses so `insertFind` writes to a fresh DB.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm -w @localfinds/agents run test -- interview-tools.test.ts -t "reviewRunResults"`
Expected: FAIL — `reviewRunResults` not exported.

- [ ] **Step 3: Implement types, reader, and server (interview-tools.ts)**

Add imports (extend the existing `@localfinds/db` import):

```ts
import { listProvisionalFinds } from "@localfinds/db";
import path from "node:path";
```

Add the types and reader:

```ts
export interface ReviewProbe {
  topic: string;
  observation: string;
  askUser: string;
}

export interface ReviewResult {
  report: string;
  calibration: string;
  probes: ReviewProbe[];
}

export interface ReviewSink {
  value?: ReviewResult;
}

export interface ReviewContext {
  runId: number;
  /** The staged prospector workspace — where coverage.md was written. */
  scratchDir: string;
}

// What the sample run produced: provisional leads (real DB) + the run's own
// narrative coverage note (where it explains what it skipped and why).
export function reviewRunResults(ctx: ReviewContext) {
  const leads = listProvisionalFinds().map((f) => ({
    title: f.title,
    score: f.score,
    url: f.url,
    summary: f.summary,
    tags: f.tags,
  }));
  let coverageNote: string | null = null;
  try {
    coverageNote = fs.readFileSync(path.join(ctx.scratchDir, "notes", "coverage.md"), "utf8");
  } catch {
    coverageNote = null; // run wrote no coverage
  }
  return { runId: ctx.runId, leads, coverageNote };
}
```

Add the server factory (mirror `buildInterviewerServer`'s structure):

```ts
export function buildReviewServer(io: InterviewIO, ctx: ReviewContext, sink: ReviewSink) {
  return createSdkMcpServer({
    name: "interviewer",
    version: "1.0.0",
    tools: [
      tool(
        "say",
        "Show the user a message (no answer expected).",
        { message: z.string() },
        async (args) => {
          io.say(args.message);
          return asText({ ok: true });
        },
      ),
      tool(
        "read_current_config",
        "Read the just-staged region, towns, category tiers, and ICP. Nulls mean 'not set yet'.",
        {},
        async () => asText(currentConfig()),
      ),
      tool(
        "read_run_results",
        "Read what the sample prospector run produced: the provisional leads it saved " +
          "(name, score, summary, tags) and the coverage note it wrote (its narrative — " +
          "what it walked, what it SKIPPED and why). Use the narrative to catch ICP " +
          "self-contradictions and mis-scoring, not just the leads it kept.",
        {},
        async () => asText(reviewRunResults(ctx)),
      ),
      tool(
        "submit_review",
        "Record your finished review. `report` is shown to the user; `probes` are the " +
          "specific things the NEXT conversation should raise (empty on the final review). " +
          "Call this exactly once, last.",
        {
          report: z.string().describe("Human-facing summary of this cycle."),
          calibration: z.string().describe("Scoring-calibration notes (over/under-scoring)."),
          probes: z
            .array(
              z.object({
                topic: z.string(),
                observation: z.string(),
                askUser: z.string(),
              }),
            )
            .describe("Findings to carry into the next conversation. Empty on the final cycle."),
        },
        async (args) => {
          sink.value = { report: args.report, calibration: args.calibration, probes: args.probes };
          io.say(args.report);
          return asText({ ok: true });
        },
      ),
    ],
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm -w @localfinds/agents run test -- interview-tools.test.ts -t "reviewRunResults"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/interview-tools.ts packages/agents/src/interview-tools.test.ts
```
```bash
git commit -m "feat(agents): review-phase tools (read_run_results, submit_review)

Read-only review server: staged config + provisional leads + the run's coverage
narrative in; a structured report + next-cycle probes out via a sink."
```

---

### Task 8: Review prompt, kickoff, and `runReview`

The system prompt and runner for the review phase.

**Files:**
- Modify: `packages/agents/src/agents/interviewer.ts` (add `REVIEW_TOOLS`, `REVIEW_SYSTEM_PROMPT`, `reviewKickoff`, `INTERVIEWER_REVIEW_EFFORT` is NOT fixed — effort is passed per call)
- Modify: `packages/agents/src/interview.ts` (add `runReview`; import the new symbols + `buildReviewServer`, `type ReviewResult`, `type ReviewSink`)
- Test: `packages/agents/src/interview-agent.test.ts` or extend `interview.test.ts` (test `reviewKickoff` pure rendering)

**Interfaces:**
- Consumes: `buildReviewServer`, `ReviewSink`, `ReviewResult` (Task 7); `logMessage`, `interviewerEnv`, `INTERVIEWER_MODEL`, `INTERVIEWER_DISALLOWED` (existing).
- Produces:
  - `REVIEW_TOOLS: string[]`, `REVIEW_SYSTEM_PROMPT: string`
  - `reviewKickoff(opts: { transcript: string; runId: number; runStatus: string; isFinal: boolean }): string`
  - `runReview(io, transcript, scratchDir, run, effort, isFinal): Promise<ReviewResult>`

- [ ] **Step 1: Write the failing test**

Add to `packages/agents/src/interview.test.ts`:

```ts
import { reviewKickoff } from "./agents/interviewer";

describe("reviewKickoff", () => {
  it("embeds the transcript + run facts and flags preliminary vs final", () => {
    const prelim = reviewKickoff({ transcript: "Q: a\nA: b", runId: 7, runStatus: "success", isFinal: false });
    expect(prelim).toContain("#7");
    expect(prelim).toContain("Q: a");
    expect(prelim).toContain("preliminary");

    const final = reviewKickoff({ transcript: "x", runId: 9, runStatus: "capped", isFinal: true });
    expect(final).toContain("FINAL");
    expect(final).toContain("empty probes");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm -w @localfinds/agents run test -- interview.test.ts -t "reviewKickoff"`
Expected: FAIL — `reviewKickoff` not exported.

- [ ] **Step 3: Add prompt, tools, kickoff (agents/interviewer.ts)**

```ts
export const REVIEW_TOOLS = [
  "mcp__interviewer__say",
  "mcp__interviewer__read_current_config",
  "mcp__interviewer__read_run_results",
  "mcp__interviewer__submit_review",
];

export const REVIEW_SYSTEM_PROMPT = `${SYSTEM_CONTEXT}

## Your mode: review — READ ONLY, you write NO config
You are given the interview transcript so far. Call read_current_config (the just-staged region/towns/categories/ICP) and read_run_results (what a small live prospector run did against that staged ICP). Judge whether the ICP behaved the way the user intends, and surface the gaps for the next round.

Hunt specifically for:
- Self-contradiction: did the run SKIP a business the user would clearly want (or SAVE one they'd reject)? A single concrete miss is worth more than aggregate counts — look in the coverage narrative, not just the saved leads.
- Mis-calibration: are scores bunched or inverted versus how the user described fit?
- Thin coverage that hid signal (too few businesses reachable to judge anything).

Then call submit_review ONCE: a short honest report, calibration notes, and — unless this is the final review — a few PROBES, each a concrete observation plus the exact question the next conversation should ask the user. Do NOT propose ICP edits yourself; the next build does that, from the user's answers. Keep probes few and high-signal.`;

// Review kickoff: transcript inline (like synthesis), plus the run's static facts
// the runner already holds.
export function reviewKickoff(opts: {
  transcript: string;
  runId: number;
  runStatus: string;
  isFinal: boolean;
}): string {
  const finalNote = opts.isFinal
    ? "This is the FINAL review — produce the closing report and submit empty probes."
    : "This is a preliminary review — submit probes for the next conversation.";
  return [
    `${finalNote} The sample run was #${opts.runId} (status: ${opts.runStatus}).`,
    "Call read_current_config and read_run_results, then submit_review.",
    "----- INTERVIEW SO FAR -----",
    opts.transcript,
    "----- END -----",
  ].join("\n\n");
}
```

- [ ] **Step 4: Add `runReview` (interview.ts)**

Extend the imports from `./agents/interviewer` to include `REVIEW_SYSTEM_PROMPT`, `REVIEW_TOOLS`, `reviewKickoff`, and from `./interview-tools` to include `buildReviewServer`, `type ReviewResult`, `type ReviewSink`, `type ReviewContext`. Then add:

```ts
async function runReview(
  io: InterviewIO,
  transcript: string,
  scratchDir: string,
  run: { runId: number; status: string },
  effort: ReasoningEffort,
  isFinal: boolean,
): Promise<ReviewResult> {
  const sink: ReviewSink = {};
  const ctx: ReviewContext = { runId: run.runId, scratchDir };
  process.stdout.write("\nReviewing the run against your answers…\n");
  try {
    for await (const message of query({
      prompt: reviewKickoff({ transcript, runId: run.runId, runStatus: run.status, isFinal }),
      options: {
        model: INTERVIEWER_MODEL,
        effort,
        env: interviewerEnv(),
        systemPrompt: REVIEW_SYSTEM_PROMPT,
        settingSources: [],
        settings: { autoMemoryEnabled: false },
        permissionMode: "bypassPermissions",
        mcpServers: { interviewer: buildReviewServer(io, ctx, sink) },
        allowedTools: REVIEW_TOOLS,
        disallowedTools: INTERVIEWER_DISALLOWED,
        maxTurns: 20,
      },
    })) {
      logMessage(message);
    }
  } catch (err) {
    console.error("\nReview ended early:", err instanceof Error ? err.message : err);
  }
  return sink.value ?? { report: "", calibration: "", probes: [] };
}
```

(`ReasoningEffort` is imported from `./run-agent` for the signature — add it to that import.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm -w @localfinds/agents run test -- interview.test.ts -t "reviewKickoff"`
Expected: PASS.

Run: `npm -w @localfinds/agents run test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/agents/src/agents/interviewer.ts packages/agents/src/interview.ts packages/agents/src/interview.test.ts
```
```bash
git commit -m "feat(agents): review phase — prompt, kickoff, runReview

Read-only review query returns a report + next-cycle probes via a sink; effort
is passed per call (low preliminary, high final)."
```

---

### Task 9: Depth dial + review-seeded collection kickoff

Parses the depth flag into a cycle count and per-cycle effort schedule, and lets the next conversation open grounded in the prior review's probes.

**Files:**
- Modify: `packages/agents/src/interview.ts` (`parseInterviewArgs` ~50)
- Modify: `packages/agents/src/agents/interviewer.ts` (`collectionKickoff` ~140; add `cycleEffort` pure helper)
- Test: `packages/agents/src/interview.test.ts`

**Interfaces:**
- Produces:
  - `type InterviewDepth = "brief" | "medium" | "comprehensive"`
  - `parseInterviewArgs(argv): { prepared: boolean; depth: InterviewDepth }` — depth from `--depth=<value>` (default `"brief"`); unknown values fall back to `"brief"`.
  - `preliminaryCycles(depth): number` — brief→0, medium→1, comprehensive→2.
  - `collectionKickoff(opts?: { resumeSeed?; prospectorContext?; reviewFindings?: ReviewProbe[] })` — renders a "raise these with the user" block from probes.

- [ ] **Step 1: Write the failing test**

Add to `packages/agents/src/interview.test.ts`:

```ts
import { parseInterviewArgs, preliminaryCycles } from "./interview";
import { collectionKickoff } from "./agents/interviewer";

describe("interview depth", () => {
  it("parses --depth and maps to preliminary cycle counts", () => {
    expect(parseInterviewArgs([]).depth).toBe("brief");
    expect(parseInterviewArgs(["--depth=comprehensive"]).depth).toBe("comprehensive");
    expect(parseInterviewArgs(["--depth=nonsense"]).depth).toBe("brief");
    expect(preliminaryCycles("brief")).toBe(0);
    expect(preliminaryCycles("medium")).toBe(1);
    expect(preliminaryCycles("comprehensive")).toBe(2);
  });

  it("collectionKickoff folds review probes into the opening", () => {
    const out = collectionKickoff({
      reviewFindings: [
        { topic: "modern-site", observation: "skipped a real maker on web grounds", askUser: "Should a modern site disqualify?" },
      ],
    });
    expect(out).toContain("modern-site");
    expect(out).toContain("Should a modern site disqualify?");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm -w @localfinds/agents run test -- interview.test.ts -t "interview depth"`
Expected: FAIL — `depth` missing, `preliminaryCycles` not exported, kickoff ignores `reviewFindings`.

- [ ] **Step 3: Extend `parseInterviewArgs` + add `preliminaryCycles` (interview.ts)**

```ts
export type InterviewDepth = "brief" | "medium" | "comprehensive";

const DEPTHS: InterviewDepth[] = ["brief", "medium", "comprehensive"];

export function parseInterviewArgs(argv: string[]): { prepared: boolean; depth: InterviewDepth } {
  const depthArg = argv.find((a) => a.startsWith("--depth="))?.slice("--depth=".length);
  const depth = DEPTHS.includes(depthArg as InterviewDepth) ? (depthArg as InterviewDepth) : "brief";
  return { prepared: argv.includes("--prepared"), depth };
}

// brief = final cycle only; medium/comprehensive add 1/2 throwaway cycles first.
export function preliminaryCycles(depth: InterviewDepth): number {
  return { brief: 0, medium: 1, comprehensive: 2 }[depth];
}
```

- [ ] **Step 4: Add `reviewFindings` to `collectionKickoff` (agents/interviewer.ts)**

Add the import for the probe type at the top of `agents/interviewer.ts`:

```ts
import type { ReviewProbe } from "../interview-tools";
```

Replace `collectionKickoff`:

```ts
export function collectionKickoff(opts?: {
  resumeSeed?: string;
  prospectorContext?: string;
  reviewFindings?: ReviewProbe[];
}): string {
  const parts = [
    "Begin the interview. Call read_current_config first, then start the conversation about their business and targeting.",
  ];
  if (opts?.prospectorContext) parts.push(opts.prospectorContext);
  if (opts?.reviewFindings?.length) {
    parts.push(
      "## A sample run just tested the current ICP — raise these with the user:\n" +
        opts.reviewFindings
          .map((p) => `- ${p.topic}: ${p.observation}\n  Ask: ${p.askUser}`)
          .join("\n"),
    );
  }
  if (opts?.resumeSeed) parts.push(opts.resumeSeed);
  return parts.join("\n\n");
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm -w @localfinds/agents run test -- interview.test.ts -t "interview depth"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/agents/src/interview.ts packages/agents/src/agents/interviewer.ts packages/agents/src/interview.test.ts
```
```bash
git commit -m "feat(agents): interview depth dial + review-seeded collection kickoff"
```

---

### Task 10: The cycle loop in `runInteractive`

Rewires `runInteractive` from the fixed two-phase flow into the depth-dialled `convo → build → run → review` loop with a staging-based final confirm. This is the I/O shell — verified by hand, not unit tests (matching how `main()` is treated today).

**Files:**
- Modify: `packages/agents/src/interview.ts` (`runInteractive` ~194-332; `main` ~404 to pass `depth`; extract `runConvo` and `runBuild` from the existing collection/synthesis blocks)
- Modify: `packages/agents/src/interview.ts` (the final gate uses `promoteStaging`/`discardStaging` + `promoteProvisionalFinds`/`discardProvisionalFinds` instead of the old `snapshot`/`restore`)

**Interfaces:**
- Consumes: everything from Tasks 1–9 plus existing `renderTranscript`, `readJournal`, `summarizeForResume`, `recentProspectorContext`, `archiveJournal`, `reviewAndConfirm`, `interviewRunId`.
- Produces: a `runInteractive(depth: InterviewDepth)` that loops `preliminaryCycles(depth) + 1` times.

- [ ] **Step 1: Extract `runConvo` and `runBuild` (interview.ts)**

Pull the existing Phase-1 collection block (current lines ~232-259) into:

```ts
async function runConvo(
  io: InterviewIO,
  kickoff: { resumeSeed?: string; prospectorContext?: string; reviewFindings?: ReviewProbe[] },
): Promise<SDKResultMessage | undefined> {
  let collected: SDKResultMessage | undefined;
  try {
    for await (const message of query({
      prompt: collectionKickoff(kickoff),
      options: {
        model: INTERVIEWER_MODEL,
        effort: INTERVIEWER_COLLECTION_EFFORT,
        env: interviewerEnv(),
        systemPrompt: COLLECTION_SYSTEM_PROMPT,
        settingSources: [],
        settings: { autoMemoryEnabled: false },
        permissionMode: "bypassPermissions",
        mcpServers: { interviewer: buildInterviewerServer(io) },
        allowedTools: COLLECTION_TOOLS,
        disallowedTools: INTERVIEWER_DISALLOWED,
        maxTurns: 200,
      },
    })) {
      logMessage(message);
      if (message.type === "result") collected = message;
    }
  } catch (err) {
    console.error("\nInterview run ended early:", err instanceof Error ? err.message : err);
  }
  return collected;
}
```

Pull the existing Phase-2 synthesis block (~283-301) into a `runBuild` that takes the effort and runs against staging (the caller sets `setConfigDirOverride`):

```ts
async function runBuild(
  io: InterviewIO,
  transcript: string,
  effort: ReasoningEffort,
): Promise<SDKResultMessage | undefined> {
  let written: SDKResultMessage | undefined;
  try {
    for await (const message of query({
      prompt: synthesisKickoff(transcript),
      options: {
        model: INTERVIEWER_MODEL,
        effort,
        env: interviewerEnv(),
        systemPrompt: SYNTHESIS_SYSTEM_PROMPT,
        settingSources: [],
        settings: { autoMemoryEnabled: false },
        permissionMode: "bypassPermissions",
        mcpServers: { interviewer: buildInterviewerServer(io) },
        allowedTools: SYNTHESIS_TOOLS,
        disallowedTools: INTERVIEWER_DISALLOWED,
        maxTurns: 60,
      },
    })) {
      logMessage(message);
      if (message.type === "result") written = message;
    }
  } catch (err) {
    console.error("\nWriting the config ended early:", err instanceof Error ? err.message : err);
  }
  return written;
}
```

- [ ] **Step 2: Rewrite `runInteractive` as the loop**

Replace the body of `runInteractive` (keep the intro, `rl`, `io`, and journal/seed setup; replace the snapshot + single-phase flow). Use `dataDir()` (import from `@localfinds/db`) for the staging root:

```ts
async function runInteractive(depth: InterviewDepth): Promise<void> {
  process.stdout.write(
    "\nNo clock here — take as long as you like. I'll ask about your business and\n" +
      "who you're trying to reach, run a quick test pass, and show you every change\n" +
      "before anything saves.\n\n",
  );
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const io: InterviewIO = {
    ask: async (question, opts) => {
      appendEntry({ role: "agent", kind: "ask", text: question });
      const hint = opts?.choices?.length ? ` [${opts.choices.join(" / ")}]` : "";
      const answer = await rlQuestion(rl, `\n${question}${hint}\n> `);
      appendEntry({ role: "user", kind: "answer", text: answer });
      process.stdout.write("\n  · got it — thinking…\n");
      return answer;
    },
    say: (message) => {
      appendEntry({ role: "agent", kind: "say", text: message });
      process.stdout.write(`\n${message}\n`);
    },
  };

  const prior = readJournal();
  const seed = prior.length ? summarizeForResume(prior) : undefined;
  if (seed) process.stdout.write("Resuming your earlier interview — picking up where you left off.\n");

  const dataRoot = dataDir();
  const runId = interviewRunId();
  const staging = createStagingDir(dataRoot, runId);
  seedStaging(dataRoot, staging);
  const prospectorContext = recentProspectorContext();

  const totalCycles = preliminaryCycles(depth) + 1;
  let lastReview: ReviewResult | undefined;
  let lastTranscript = "";

  for (let c = 0; c < totalCycles; c++) {
    const isFinal = c === totalCycles - 1;
    const buildEffort: ReasoningEffort = isFinal ? "high" : "low";
    const reviewEffort: ReasoningEffort = isFinal ? "high" : "low";
    process.stdout.write(`\n===== Cycle ${c + 1} of ${totalCycles}${isFinal ? " (final)" : ""} =====\n`);

    // ── CONVO ──
    const convo = await runConvo(io, {
      resumeSeed: c === 0 ? seed : undefined,
      prospectorContext: prospectorContext || undefined,
      reviewFindings: lastReview?.probes,
    });
    if (convo?.subtype !== "success") {
      process.stdout.write(
        "\nThe interview didn't finish. Re-run `npm run interview` to resume where you left off.\n",
      );
      discardStaging(staging);
      rl.close();
      return;
    }
    lastTranscript = renderTranscript(readJournal());
    if (!lastTranscript.trim()) {
      process.stdout.write("\nNo answers were captured, so there's nothing to write.\n");
      discardStaging(staging);
      rl.close();
      return;
    }

    // ── BUILD (writes to staging) ──
    process.stdout.write("\nWriting up your targeting and ICP for this pass…\n");
    setConfigDirOverride(staging);
    let built: SDKResultMessage | undefined;
    try {
      built = await runBuild(io, lastTranscript, buildEffort);
    } finally {
      setConfigDirOverride(undefined);
    }
    if (built?.subtype !== "success") {
      process.stdout.write("\nI couldn't write the config from the interview this pass.\n");
      discardStaging(staging);
      discardProvisionalFinds();
      rl.close();
      return;
    }

    // ── RUN (provisional leads; clear any from a prior cycle first) ──
    discardProvisionalFinds();
    const run = await runProspectorSample(staging);

    // ── REVIEW ──
    lastReview = await runReview(io, lastTranscript, path.join(staging, "agents", "prospector"), run, reviewEffort, isFinal);
  }

  // ── FINAL GATE ── (confirmStaging is defined in Step 3 below)
  const keep = await confirmStaging(rl, dataRoot, staging);
  if (keep) {
    promoteStaging(dataRoot, staging);
    const promoted = promoteProvisionalFinds();
    discardStaging(staging);
    const archived = archiveJournal(runId);
    process.stdout.write(
      `\nSaved${promoted ? ` — ${promoted} lead(s) added to your feed` : ""}. ` +
        "Run `npm run agent -- prospector` for a full pass.\n",
    );
    if (archived) process.stdout.write(`Transcript kept at ${path.relative(process.cwd(), archived)}\n`);
  } else {
    discardStaging(staging);
    discardProvisionalFinds();
    process.stdout.write("\nReverted — your earlier config is unchanged.\n");
  }
  rl.close();
}
```

- [ ] **Step 3: Adapt the confirm diff to staging vs. real**

The existing `reviewAndConfirm` diffs a `before` snapshot map against the current real files. With staging, diff the **real** files against the **staged** files. Define this `confirmStaging` helper (the final gate in Step 2 already calls it):

```ts
// Diff each real config artifact against its staged version and ask to keep.
async function confirmStaging(
  rl: readline.Interface,
  dataRoot: string,
  stagingDir: string,
): Promise<boolean> {
  const rels = [
    { label: "data/config/region.md", rel: "config/region.md" },
    { label: "data/config/towns.json", rel: "config/towns.json" },
    { label: "data/config/categories.json", rel: "config/categories.json" },
    { label: "data/agents/prospector/profile.md", rel: "agents/prospector/profile.md" },
  ];
  const changed = rels
    .map((f) => ({
      label: f.label,
      diff: lineDiff(
        readOrNull(path.join(dataRoot, f.rel)) ?? "",
        readOrNull(path.join(stagingDir, f.rel)) ?? "",
      ),
    }))
    .filter((c) => c.diff !== "");

  if (changed.length === 0) {
    process.stdout.write("\nNo configuration changes were made.\n");
    return true;
  }
  process.stdout.write("\n===== Proposed changes =====\n");
  for (const c of changed) process.stdout.write(`\n--- ${c.label} ---\n${c.diff}\n`);
  const ans = (await rlQuestion(rl, "\nKeep these changes? (y/N) ")).trim().toLowerCase();
  return ans === "y" || ans === "yes";
}
```

Step 2's final gate already calls `confirmStaging`. The old `snapshot`/`restore`/`reviewAndConfirm`/`targetConfigFiles`/`TargetFile` machinery (current lines ~87-166, 224-225, 307-323) is now unused — delete `snapshot`, `restore`, `reviewAndConfirm`, `targetConfigFiles`, and the `TargetFile` interface, keeping `readOrNull` and `lineDiff` (both still used).

- [ ] **Step 4: Update `main` to pass depth (interview.ts ~404)**

```ts
async function main(): Promise<void> {
  loadEnv();
  const { prepared, depth } = parseInterviewArgs(process.argv.slice(2));
  if (prepared) await runPrepared();
  else await runInteractive(depth);
}
```

- [ ] **Step 5: Typecheck + full agents suite**

Run: `npm -w @localfinds/agents run test`
Expected: PASS — pure-helper tests green; the I/O shell compiles. Fix any unused-import or type errors surfaced by the deletions in Step 3.

- [ ] **Step 6: Manual end-to-end smoke (brief)**

This requires a real region in `data/config/` and an `ANTHROPIC_API_KEY`. Run:
`npm run interview -- --depth=brief`

Verify by hand:
- One cycle runs: convo → "Writing up…" → "Running a quick prospector pass…" (streamed tool calls visible) → "Reviewing the run…" → report.
- The final diff lists `data/config/*` + `profile.md` changes; answering **N** leaves real config untouched (`git status` shows no `data/` config change) and removes provisional leads (`sqlite3 data/localfinds.db "select count(*) from finds where status='provisional'"` → 0).
- Answering **y** on a second run promotes leads (the same query → 0 provisional, and the new leads appear with status `new`).
- After either answer, no `.staging-*` dir remains under `data/` (`ls -a data/ | grep staging` → empty).

Document the smoke result in the commit body.

- [ ] **Step 7: Commit**

```bash
git add packages/agents/src/interview.ts
```
```bash
git commit -m "feat(agents): depth-dialled convo→build→run→review interview loop

runInteractive now loops N preliminary + 1 final cycle, staging all config/ICP
writes and provisional leads until a single end-of-interview confirm. Manual
brief smoke: cycle ran, reject left config untouched + dropped provisional
leads, accept promoted them, staging cleaned up."
```

---

### Task 11: Prospector logs near-misses (the review linchpin)

The review phase can only catch false-negatives if the prospector records what it *skipped*, not just what it kept. One prompt change.

**Files:**
- Modify: `packages/agents/src/agents/prospector.ts` (`buildTaskPrompt` step 7 ~line 62)
- Test: `packages/agents/src/prospector.test.ts` (create — assert the prompt contains the near-miss instruction)

**Interfaces:**
- No code interface change; a prompt-content guarantee the review phase depends on.

- [ ] **Step 1: Write the failing test**

Create `packages/agents/src/prospector.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { prospector } from "./agents/prospector";

describe("prospector coverage prompt", () => {
  it("instructs logging near-misses (skipped-but-notable businesses)", () => {
    const prompt = prospector.buildTaskPrompt({ region: "R", profile: "P", categories: "C" });
    expect(prompt.toLowerCase()).toContain("near-miss");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm -w @localfinds/agents run test -- prospector.test.ts`
Expected: FAIL — prompt has no "near-miss" text.

- [ ] **Step 3: Tighten step 7 (prospector.ts)**

Replace the step-7 line in `buildTaskPrompt`:

```ts
7. Finish by updating notes/coverage.md with a dated entry on what you walked and what to try next run, plus any ICP signals worth recording. Explicitly log NEAR-MISSES: businesses you almost saved but skipped, and businesses you skipped that a reader might expect you to keep — name them and say which ICP rule drove the skip. These near-miss notes are how the profile gets calibrated, so be concrete.`,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm -w @localfinds/agents run test -- prospector.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/agents/prospector.ts packages/agents/src/prospector.test.ts
```
```bash
git commit -m "feat(agents): prospector logs near-misses in coverage notes

The review phase reads the coverage narrative to catch ICP false-negatives, so
the prospector must record what it skipped and why, not just what it kept."
```

---

## Final verification

- [ ] **Run the whole suite**

Run: `npm test`
Expected: PASS across `@localfinds/db`, `@localfinds/agents`, `@localfinds/web`.

- [ ] **Confirm the prepared path still works** (it reuses synthesis, which now writes through `configDir()` with the override unset → real files, unchanged):

Run: `npm run interview -- --prepared` (with a filled `questionnaire.md`)
Expected: writes real config + asks to keep, exactly as before this change.

---

## Notes for the implementer

- **Why the DB stays real while config is staged:** `dbPath()` derives from `dataDir()`, never `configDir()`. The `setConfigDirOverride` switch (Task 3) moves only the four interviewer artifacts. Provisional leads give the DB its own isolation (Task 1), so there's no second database to merge.
- **Why `provisional` exclusion is tested behaviorally:** the risk is missing a query that filters `status != 'hidden'`. Task 1's test asserts a provisional find is absent from the feed, tags, and types. If a reviewer finds another user-facing count/list, mirror the `not in ('hidden', 'provisional')` clause there and extend the test.
- **Coverage is NOT promoted.** The sample run walks a tiny slice; promoting its `coverage.md` cursor would make the scheduled prospector skip towns. Only region/towns/categories/profile promote (Task 5's `STAGED_ARTIFACTS`); the staged `coverage.md` is discarded with the staging dir.
- **Cross-cycle crash resume is out of scope** for this plan. `summarizeForResume` still resumes an interrupted *single* conversation; a crash mid-run leaves a `.staging-*` dir that the next run ignores (a new run id makes a fresh one). A follow-up could add a journal phase-marker to re-enter the loop at the right cycle — note it, don't build it here.
- **API swap is a later, separate change** at `list_businesses` inside `buildLocalfindsServer`; nothing in this plan's interview cycle changes when it lands.
