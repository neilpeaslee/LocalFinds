# Scout Fetch Logging + Host-Blocking Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Log every scout WebFetch outcome to a `fetches` table and hard-block hosts that return 403/401 on 3 consecutive runs.

**Architecture:** Pure helpers classify WebFetch result text and extract hosts (`packages/agents/src/web-fetch-log.ts`); a DB table + queries persist outcomes and compute the blocklist (`packages/db`); `run-agent` wires logging into its existing message loop and installs a `PreToolUse` WebFetch guard. Scout-only for now.

**Tech Stack:** TypeScript, Drizzle ORM + better-sqlite3, Vitest, `@anthropic-ai/claude-agent-sdk` v0.3.175.

## Global Constraints

- Logging and blocking apply to **scout only** (`def.name === "scout"`); other agents unaffected.
- Strike threshold **N = 3**; only `klass === "blocked"` (HTTP 401/403) counts as a strike. 429/5xx (`error`), `truncated`, and `ok` never strike and break a streak.
- `packages/db` must not import from `packages/agents`. The `FetchClass` type is defined in `packages/db` and imported by `packages/agents`.
- Logging failures must never fail a run — wrap the record call in try/catch (mirror the cartographer dedupe sweep in `run-agent.ts`).
- Follow existing patterns: pure logic lives in SDK/db-free modules (like `overpass.ts`); DB access lives in `queries.ts`; tests use Vitest.
- Spec: `docs/superpowers/specs/2026-06-21-scout-fetch-logging-design.md`.

---

### Task 1: `fetches` table, `recordFetch`, `clearFetchHistory`

**Files:**
- Modify: `packages/db/src/schema.ts` (add `fetches` table + `FetchClass` type, after the `runs` table ~line 123)
- Modify: `packages/db/src/queries.ts` (add `recordFetch`, `clearFetchHistory`; ensure `fetches` is imported from `./schema`)
- Test: `packages/db/src/queries.test.ts` (append a new `describe`)

**Interfaces:**
- Produces:
  - `fetches` Drizzle table.
  - `type FetchClass = "ok" | "blocked" | "truncated" | "error"`
  - `recordFetch(input: { runId: number; agent: string; host: string; url: string; status: number | null; klass: FetchClass; via?: string }): void`
  - `clearFetchHistory(host: string): number`

- [ ] **Step 1: Add the table + type to `schema.ts`**

After the `runs` table definition (before the `export type` block near line 125), add:

```ts
// One row per WebFetch call (scout, for now). klass is the durable signal;
// status is best-effort (often 200 by assumption on success). via is reserved
// for a future controlled fetch tool so it can be added without a migration.
export const fetches = sqliteTable(
  "fetches",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: integer("run_id").references(() => runs.id),
    agent: text("agent").notNull(),
    host: text("host").notNull(),
    url: text("url").notNull(),
    method: text("method").notNull().default("GET"),
    status: integer("status"),
    klass: text("klass", {
      enum: ["ok", "blocked", "truncated", "error"],
    }).notNull(),
    via: text("via").notNull().default("webfetch"),
    ts: text("ts").notNull(),
  },
  (t) => [index("fetches_host_idx").on(t.host), index("fetches_run_idx").on(t.runId)],
);

export type FetchClass = (typeof fetches.$inferInsert)["klass"];
```

Add `export type Fetch = typeof fetches.$inferSelect;` to the existing `export type` block at the bottom.

- [ ] **Step 2: Add `recordFetch` + `clearFetchHistory` to `queries.ts`**

Ensure the import from `./schema` includes `fetches` (add it to the existing `import { ... } from "./schema"` list). Then append:

```ts
import type { FetchClass } from "./schema"; // if not already importing types from schema; otherwise add `fetches`, `FetchClass` to existing imports

export function recordFetch(input: {
  runId: number;
  agent: string;
  host: string;
  url: string;
  status: number | null;
  klass: FetchClass;
  via?: string;
}): void {
  db()
    .insert(fetches)
    .values({
      runId: input.runId,
      agent: input.agent,
      host: input.host,
      url: input.url,
      status: input.status,
      klass: input.klass,
      via: input.via ?? "webfetch",
      ts: new Date().toISOString(),
    })
    .run();
}

// Manual un-block: drop a host's fetch history so it is no longer hard-blocked.
export function clearFetchHistory(host: string): number {
  return db().delete(fetches).where(eq(fetches.host, host)).run().changes;
}
```

(`eq` and `db` are already imported in `queries.ts`. If `fetches`/`FetchClass` are not yet imported, add them to the existing `./schema` import.)

- [ ] **Step 3: Write the failing tests**

Append to `packages/db/src/queries.test.ts`:

```ts
describe("recordFetch / clearFetchHistory", () => {
  it("inserts a fetch row with defaults and reads it back", () => {
    q.recordFetch({
      runId: 1,
      agent: "scout",
      host: "example.org",
      url: "https://example.org/a",
      status: 200,
      klass: "ok",
    });
    const rows = q.listFetchesForHost("example.org");
    expect(rows.length).toBe(1);
    expect(rows[0].method).toBe("GET");
    expect(rows[0].via).toBe("webfetch");
    expect(rows[0].klass).toBe("ok");
  });

  it("clearFetchHistory deletes a host's rows and returns the count", () => {
    q.recordFetch({ runId: 1, agent: "scout", host: "wipe.org", url: "https://wipe.org/1", status: 403, klass: "blocked" });
    q.recordFetch({ runId: 1, agent: "scout", host: "wipe.org", url: "https://wipe.org/2", status: 403, klass: "blocked" });
    const deleted = q.clearFetchHistory("wipe.org");
    expect(deleted).toBe(2);
    expect(q.listFetchesForHost("wipe.org").length).toBe(0);
  });
});
```

This test references a small read helper `listFetchesForHost`. Add it to `queries.ts` (it keeps the test independent of internal column ordering):

```ts
export function listFetchesForHost(host: string) {
  return db()
    .select()
    .from(fetches)
    .where(eq(fetches.host, host))
    .orderBy(asc(fetches.id))
    .all();
}
```

(`asc` is already imported in `queries.ts`.)

- [ ] **Step 4: Run tests — expect FAIL first, then PASS**

Run: `cd packages/db && npx vitest run src/queries.test.ts -t "recordFetch"`
Expected first run: FAIL (table/functions not present). After Steps 1-2 are in place: PASS.

Note: the test harness runs `drizzle-kit push --force` in `beforeAll`, so the new `fetches` table is created automatically from `schema.ts` — no manual migration needed for tests.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema.ts packages/db/src/queries.test.ts
git add packages/db/src/queries.ts
git commit -m "feat(db): add fetches log table, recordFetch, clearFetchHistory"
```

---

### Task 2: `blockedHosts` query

**Files:**
- Modify: `packages/db/src/queries.ts` (add `blockedHosts`)
- Test: `packages/db/src/queries.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: `fetches` table, `recordFetch` (Task 1).
- Produces: `blockedHosts(strikes?: number): string[]` — default `strikes = 3`. A host is returned when its most-recent `strikes` fetch outcomes (newest-first by `id`) are all `klass === "blocked"`, uninterrupted.

- [ ] **Step 1: Write the failing tests**

Append to `packages/db/src/queries.test.ts`:

```ts
describe("blockedHosts", () => {
  const rec = (host: string, klass: "ok" | "blocked" | "truncated" | "error") =>
    q.recordFetch({ runId: 1, agent: "scout", host, url: `https://${host}/x`, status: klass === "blocked" ? 403 : 200, klass });

  it("blocks a host after N consecutive blocked outcomes", () => {
    rec("blocked3.org", "blocked");
    rec("blocked3.org", "blocked");
    rec("blocked3.org", "blocked");
    expect(q.blockedHosts(3)).toContain("blocked3.org");
  });

  it("does not block with only N-1 strikes", () => {
    rec("twice.org", "blocked");
    rec("twice.org", "blocked");
    expect(q.blockedHosts(3)).not.toContain("twice.org");
  });

  it("a non-blocked outcome breaks the streak (newest-first)", () => {
    rec("recovered.org", "blocked");
    rec("recovered.org", "blocked");
    rec("recovered.org", "blocked");
    rec("recovered.org", "ok"); // newest
    expect(q.blockedHosts(3)).not.toContain("recovered.org");
  });

  it("error (429/5xx) does not count as a strike and breaks the streak", () => {
    rec("flaky.org", "blocked");
    rec("flaky.org", "blocked");
    rec("flaky.org", "error"); // newest — transient, not a strike
    expect(q.blockedHosts(3)).not.toContain("flaky.org");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/db && npx vitest run src/queries.test.ts -t "blockedHosts"`
Expected: FAIL with "q.blockedHosts is not a function".

- [ ] **Step 3: Implement `blockedHosts`**

Append to `packages/db/src/queries.ts`:

```ts
// Hosts to hard-block: those whose most-recent `strikes` fetch outcomes were
// all blocked (403/401), uninterrupted. Newest-first is by id (insertion order),
// which is monotonic and deterministic — no dependence on ts clock resolution.
export function blockedHosts(strikes = 3): string[] {
  const rows = db()
    .select({ host: fetches.host, klass: fetches.klass })
    .from(fetches)
    .orderBy(desc(fetches.id))
    .limit(2000)
    .all();

  const state = new Map<string, { streak: number; done: boolean }>();
  const blocked: string[] = [];
  for (const r of rows) {
    const s = state.get(r.host) ?? { streak: 0, done: false };
    if (s.done) continue;
    if (r.klass === "blocked") {
      s.streak += 1;
      if (s.streak >= strikes && !blocked.includes(r.host)) blocked.push(r.host);
    } else {
      s.done = true; // first non-blocked (newest-first) ends this host's streak
    }
    state.set(r.host, s);
  }
  return blocked;
}
```

(`desc` is already imported in `queries.ts`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/db && npx vitest run src/queries.test.ts -t "blockedHosts"`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/queries.ts packages/db/src/queries.test.ts
git commit -m "feat(db): add blockedHosts (N-strike 403/401 host blocklist)"
```

---

### Task 3: `web-fetch-log.ts` pure helpers

**Files:**
- Create: `packages/agents/src/web-fetch-log.ts`
- Test: `packages/agents/src/web-fetch-log.test.ts`

**Interfaces:**
- Consumes: `type FetchClass` from `@localfinds/db` (Task 1).
- Produces:
  - `classifyWebFetchResult(text: string): { klass: FetchClass; status: number | null }`
  - `webFetchResultText(content: unknown): string`
  - `hostOf(url: string): string | null`

- [ ] **Step 1: Write the failing tests**

Create `packages/agents/src/web-fetch-log.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { classifyWebFetchResult, hostOf, webFetchResultText } from "./web-fetch-log";

describe("classifyWebFetchResult", () => {
  it("classifies a 403 as blocked", () => {
    expect(classifyWebFetchResult("The server returned HTTP 403 Forbidden.")).toEqual({ klass: "blocked", status: 403 });
  });
  it("classifies a 401 as blocked", () => {
    expect(classifyWebFetchResult("The server returned HTTP 401 Unauthorized.")).toEqual({ klass: "blocked", status: 401 });
  });
  it("classifies other HTTP codes as error", () => {
    expect(classifyWebFetchResult("The server returned HTTP 500.")).toEqual({ klass: "error", status: 500 });
  });
  it("classifies truncation as truncated/200", () => {
    expect(classifyWebFetchResult("Some content...\n[Content truncated due to length...]")).toEqual({ klass: "truncated", status: 200 });
  });
  it("classifies plain content as ok/200", () => {
    expect(classifyWebFetchResult("# Events\n- Concert on July 4")).toEqual({ klass: "ok", status: 200 });
  });
});

describe("webFetchResultText", () => {
  it("returns a string as-is", () => {
    expect(webFetchResultText("hello")).toBe("hello");
  });
  it("joins a text-block array", () => {
    expect(webFetchResultText([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("a\nb");
  });
  it("stringifies anything else without throwing", () => {
    expect(typeof webFetchResultText({ weird: 1 })).toBe("string");
  });
});

describe("hostOf", () => {
  it("extracts a lowercase hostname", () => {
    expect(hostOf("https://Owlshead.org/events/")).toBe("owlshead.org");
  });
  it("returns null on an unparseable url", () => {
    expect(hostOf("not a url")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/agents && npx vitest run src/web-fetch-log.test.ts`
Expected: FAIL ("Cannot find module './web-fetch-log'").

- [ ] **Step 3: Implement the helpers**

Create `packages/agents/src/web-fetch-log.ts`:

```ts
// Pure helpers for logging WebFetch outcomes. No SDK/db imports (type-only) so
// this stays unit-testable in isolation, mirroring overpass.ts.
import type { FetchClass } from "@localfinds/db";

// The SDK flattens WebFetch results to text by the time we see them. Derive a
// coarse class from that text: blocked (401/403), error (other HTTP codes),
// truncated (size marker), or ok (got content).
export function classifyWebFetchResult(text: string): {
  klass: FetchClass;
  status: number | null;
} {
  const httpMatch = text.match(/HTTP (\d{3})/i);
  if (httpMatch) {
    const status = Number(httpMatch[1]);
    if (status === 401 || status === 403) return { klass: "blocked", status };
    return { klass: "error", status };
  }
  if (text.includes("[Content truncated due to length")) {
    return { klass: "truncated", status: 200 };
  }
  return { klass: "ok", status: 200 };
}

// A tool_result's content may be a string or an array of text blocks.
export function webFetchResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        b && typeof b === "object" && "text" in b && typeof (b as { text: unknown }).text === "string"
          ? (b as { text: string }).text
          : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/agents && npx vitest run src/web-fetch-log.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/web-fetch-log.ts packages/agents/src/web-fetch-log.test.ts
git commit -m "feat(agents): pure WebFetch result classifier + host helpers"
```

---

### Task 4: `makeWebFetchGuard` PreToolUse hook

**Files:**
- Modify: `packages/agents/src/path-guard.ts` (add `makeWebFetchGuard`)
- Test: `packages/agents/src/path-guard.test.ts` (create — none exists yet)

**Interfaces:**
- Consumes: `hostOf` from `./web-fetch-log` (Task 3).
- Produces: `makeWebFetchGuard(blocked: Set<string>): HookCallback` — denies a `WebFetch` PreToolUse call whose URL host is in `blocked`; allows everything else; fails open on an unparseable URL.

- [ ] **Step 1: Write the failing tests**

Create `packages/agents/src/path-guard.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { makeWebFetchGuard } from "./path-guard";

const call = (guard: ReturnType<typeof makeWebFetchGuard>, url: unknown) =>
  guard(
    { hook_event_name: "PreToolUse", tool_input: { url } } as never,
    undefined as never,
    undefined as never,
  );

describe("makeWebFetchGuard", () => {
  it("denies a fetch to a blocked host", async () => {
    const out = await call(makeWebFetchGuard(new Set(["owlshead.org"])), "https://owlshead.org/events/");
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  it("allows a fetch to a non-blocked host", async () => {
    const out = await call(makeWebFetchGuard(new Set(["owlshead.org"])), "https://merryspring.org/calendar/");
    expect(out).toEqual({});
  });

  it("fails open on an unparseable url", async () => {
    const out = await call(makeWebFetchGuard(new Set(["owlshead.org"])), "not a url");
    expect(out).toEqual({});
  });

  it("ignores non-PreToolUse events", async () => {
    const guard = makeWebFetchGuard(new Set(["owlshead.org"]));
    const out = await guard({ hook_event_name: "PostToolUse" } as never, undefined as never, undefined as never);
    expect(out).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/agents && npx vitest run src/path-guard.test.ts`
Expected: FAIL ("makeWebFetchGuard is not exported").

- [ ] **Step 3: Implement the guard**

Add to `packages/agents/src/path-guard.ts` (keep the existing `makePathGuard`; add the import and the new function):

```ts
import { hostOf } from "./web-fetch-log";

// PreToolUse hook for WebFetch: deny fetches to hosts on the blocklist (computed
// from the fetches table). Model-independent backstop for the prompt's
// "hosts to skip" note. Fails open on a URL we can't parse — WebFetch will
// reject a malformed URL on its own; the guard's only job is the blocklist.
export function makeWebFetchGuard(blocked: Set<string>): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
    const url = toolInput.url;
    if (typeof url !== "string") return {};
    const host = hostOf(url);
    if (host && blocked.has(host)) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse" as const,
          permissionDecision: "deny" as const,
          permissionDecisionReason: `Host ${host} returned 403/401 on the last several runs — skip it; do not fetch this URL.`,
        },
      };
    }
    return {};
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/agents && npx vitest run src/path-guard.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/path-guard.ts packages/agents/src/path-guard.test.ts
git commit -m "feat(agents): WebFetch PreToolUse guard for blocked hosts"
```

---

### Task 5: Wire logging + blocking into `run-agent`

**Files:**
- Modify: `packages/agents/src/run-agent.ts`

**Interfaces:**
- Consumes: `blockedHosts`, `recordFetch` (`@localfinds/db`); `classifyWebFetchResult`, `webFetchResultText`, `hostOf` (`./web-fetch-log`); `makeWebFetchGuard` (`./path-guard`).
- Produces: no new exports; behavioral change — scout runs now log fetches and skip blocked hosts.

- [ ] **Step 1: Add imports and the strike constant**

In `packages/agents/src/run-agent.ts`, extend the `@localfinds/db` import to include `blockedHosts` and `recordFetch`, and add:

```ts
import { classifyWebFetchResult, hostOf, webFetchResultText } from "./web-fetch-log";
import { makePathGuard, makeWebFetchGuard } from "./path-guard";

// A scout host is hard-blocked after this many consecutive 403/401 outcomes.
const STRIKE_THRESHOLD = 3;
```

(Replace the existing `import { makePathGuard } from "./path-guard";` line with the combined import above.)

- [ ] **Step 2: Compute the blocklist and inject the prompt note**

After `if (opts.extraPrompt) prompt += ...` and before `const model = ...`, add:

```ts
// Scout-only: skip hosts that have repeatedly 403/401'd. The prompt note avoids
// wasting a turn on a denial; the PreToolUse guard (below) is the hard backstop.
const blocked = def.name === "scout" ? blockedHosts(STRIKE_THRESHOLD) : [];
if (blocked.length > 0) {
  prompt +=
    "\n\n## Hosts to skip\n" +
    "These hosts repeatedly returned 403/401 and are blocked this run — do not fetch them:\n" +
    blocked.map((h) => `- ${h}`).join("\n");
}
const blockedSet = new Set(blocked);
```

- [ ] **Step 3: Install the WebFetch guard hook**

In the `hooks.PreToolUse` array inside the `query({ options: { ... } })` call, add a second entry alongside the existing file-tool guard:

```ts
hooks: {
  PreToolUse: [
    {
      matcher: "Read|Write|Edit|Glob|Grep",
      hooks: [makePathGuard(workspace)],
    },
    {
      matcher: "WebFetch",
      hooks: [makeWebFetchGuard(blockedSet)],
    },
  ],
},
```

- [ ] **Step 4: Log fetch outcomes in the message loop**

Just before the `for await (const message of query(...))` loop, declare the URL map:

```ts
const fetchUrls = new Map<string, string>(); // WebFetch tool_use id -> url
```

Replace the existing inner events loop:

```ts
const events = projectMessage(message);
for (const ev of events) log.write(ev);
warnings += countRunWarnings(events);
```

with:

```ts
const events = projectMessage(message);
for (const ev of events) {
  log.write(ev);
  if (ev.kind === "tool_use" && ev.name === "WebFetch") {
    const url = (ev.input as { url?: unknown })?.url;
    if (typeof url === "string") fetchUrls.set(ev.id, url);
  } else if (ev.kind === "tool_result" && fetchUrls.has(ev.toolUseId)) {
    const url = fetchUrls.get(ev.toolUseId)!;
    fetchUrls.delete(ev.toolUseId);
    // Logging must never fail a run.
    try {
      const { klass, status } = classifyWebFetchResult(webFetchResultText(ev.content));
      recordFetch({
        runId,
        agent: def.name,
        host: hostOf(url) ?? url,
        url,
        status,
        klass,
      });
    } catch (err) {
      console.error(`[${def.name}] recordFetch failed:`, err);
    }
  }
}
warnings += countRunWarnings(events);
```

- [ ] **Step 5: Typecheck + full agents test suite**

Run: `cd packages/agents && npx tsc --noEmit && npx vitest run`
Expected: tsc exits 0; all tests PASS (including the new web-fetch-log and path-guard suites).

Run: `cd packages/db && npx vitest run`
Expected: all PASS (including new fetches/blockedHosts suites).

- [ ] **Step 6: Manual verification (the loop is not unit-tested)**

Create the table in the dev DB and do a real scout run:

```bash
cd packages/db && npx drizzle-kit push --force && cd ../..
npx tsx packages/agents/src/cli.ts scout   # or the project's usual scout-run command
sqlite3 data/localfinds.db "SELECT host, klass, status, count(*) FROM fetches GROUP BY host, klass ORDER BY count(*) DESC;"
```

Expected: one row per WebFetch the run made, with sensible `klass` values (e.g. `owlshead.org | blocked | 403`). Confirm the run still completes and the `fetches` table is populated.

To exercise the hard block deterministically without waiting for 3 real runs, seed strikes and confirm the prompt note + guard engage on the next run:

```bash
sqlite3 data/localfinds.db "INSERT INTO fetches (run_id,agent,host,url,method,status,klass,via,ts) VALUES (1,'scout','owlshead.org','https://owlshead.org/x','GET',403,'blocked','webfetch','2026-06-21T00:00:00Z'),(1,'scout','owlshead.org','https://owlshead.org/y','GET',403,'blocked','webfetch','2026-06-21T00:00:01Z'),(1,'scout','owlshead.org','https://owlshead.org/z','GET',403,'blocked','webfetch','2026-06-21T00:00:02Z');"
```

Then re-run scout and confirm (in the run log) the "Hosts to skip" note is present and no WebFetch to `owlshead.org` succeeds. Clean up with `clearFetchHistory("owlshead.org")` or `DELETE FROM fetches WHERE host='owlshead.org';` afterward if desired.

- [ ] **Step 7: Commit**

```bash
git add packages/agents/src/run-agent.ts
git commit -m "feat(agents): scout logs WebFetch outcomes and skips blocked hosts"
```

---

## Self-Review notes (for the implementer)

- **Spec coverage:** Task 1 → fetches table + recordFetch + manual-unblock (`clearFetchHistory`); Task 2 → `blockedHosts` N-strike rule; Task 3 → `classifyWebFetchResult` + content normalization + host extraction; Task 4 → hard-block hook; Task 5 → auto-logging, prompt memory, hook install, scout-only gating. UI surfacing and a `fetch_url` tool are intentionally absent (out of scope).
- **Type consistency:** `FetchClass` defined once in `schema.ts`, imported by `web-fetch-log.ts` and used by `recordFetch`. `classifyWebFetchResult` returns the same `{ klass, status }` shape that `recordFetch` consumes. `hostOf` is defined in Task 3 and reused in Task 4 and Task 5.
- **Determinism:** `blockedHosts` orders by `id` (insertion order), not `ts`, so tests need no sleeps.
```
