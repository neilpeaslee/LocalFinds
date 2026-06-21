# iCal Feeds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the agents read venue iCal feeds (e.g. owlshead.org's `?ical=1`) as a structured, block-bypassing source type — source-keeper discovers feeds, scout pulls events into finds.

**Architecture:** A single pure+HTTP module `packages/agents/src/ical.ts` (mirroring `overpass.ts`) holds an iCal parser, a browser-UA raw fetch with candidate-URL probing, and a tool-result formatter. A `fetch_ical` MCP tool exposes it. A new `sources.ical_url` column stores discovered feeds. source-keeper records feeds (and auto-activates feed-backed sources); scout consumes them.

**Tech Stack:** TypeScript, Drizzle ORM + better-sqlite3, Vitest, `@anthropic-ai/claude-agent-sdk`. No new dependencies.

## Global Constraints

- Branch: `feat/ical-feeds` (off `main`). Build here.
- `ical.ts` is a pure-logic + HTTP module with NO SDK/db imports (it may import the shared `ToolTextResult` type from `./overpass`), mirroring `overpass.ts` so it stays unit-testable via an injected `fetchImpl`.
- Hand-rolled parser; **no new npm dependency**.
- **No RRULE expansion** — take each VEVENT's `DTSTART` as-is; drop a VEVENT that has no `DTSTART`.
- `fetch_ical` is an MCP tool (`mcp__localfinds__fetch_ical`), added to BOTH scout and source-keeper `allowedTools`.
- Dates are stored as wall-clock ISO strings (no timezone math), consistent with how the agents record dates.
- `sources.ical_url` requires `npx drizzle-kit push` to materialize (tests run it in `beforeAll`; dev/prod run it as a deploy step).
- Repo rule: `git add` and `git commit` are ALWAYS separate commands, never combined.
- Spec: `docs/superpowers/specs/2026-06-21-ical-feeds-design.md`.

---

### Task 1: iCal parser (pure)

**Files:**
- Create: `packages/agents/src/ical.ts`
- Test: `packages/agents/src/ical.test.ts`

**Interfaces:**
- Produces:
  - `interface ICalEvent { summary: string | null; start: string | null; end: string | null; url: string | null; location: string | null }`
  - `parseICal(text: string): ICalEvent[]` — VEVENTs with a parseable `DTSTART`; dates as ISO; text unescaped.
  - `isVCalendar(text: string): boolean`
  - `icalCandidates(url: string): string[]` — probe order, de-duped, ≤5.

- [ ] **Step 1: Write the failing tests**

Create `packages/agents/src/ical.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { icalCandidates, isVCalendar, parseICal } from "./ical";

// Fixture exercises: folded continuation line, TZID datetime, VALUE=DATE all-day,
// escaped chars, an event with no DTSTART (dropped), and a VTIMEZONE (ignored).
const SAMPLE = [
  "BEGIN:VCALENDAR",
  "PRODID:-//Owls Head//ECPv6.16.3//EN",
  "BEGIN:VTIMEZONE",
  "TZID:America/New_York",
  "END:VTIMEZONE",
  "BEGIN:VEVENT",
  "SUMMARY:Camp: Pit Stop Pals\\, ages 6-9",
  "DTSTART;TZID=America/New_York:20260629T090000",
  "DTEND;TZID=America/New_York:20260629T150000",
  "LOCATION:117 Museum St\\nOwls Head\\, ME",
  "URL:https://owlshead.org/event/camp-pit-stop-pals/2026-06-29/",
  "DESCRIPTION:A long description that is folded across",
  " two physical lines into one logical value.",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "SUMMARY:All Day Open House",
  "DTSTART;VALUE=DATE:20260704",
  "URL:https://owlshead.org/event/open-house/",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "SUMMARY:Broken event with no start",
  "URL:https://owlshead.org/event/broken/",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

describe("isVCalendar", () => {
  it("detects a calendar body", () => {
    expect(isVCalendar(SAMPLE)).toBe(true);
  });
  it("rejects non-calendar text", () => {
    expect(isVCalendar("<html>403 Forbidden</html>")).toBe(false);
  });
});

describe("parseICal", () => {
  const events = parseICal(SAMPLE);

  it("drops VEVENTs with no DTSTART and ignores VTIMEZONE", () => {
    expect(events).toHaveLength(2);
  });
  it("parses a TZID datetime to ISO wall-clock", () => {
    expect(events[0].start).toBe("2026-06-29T09:00:00");
    expect(events[0].end).toBe("2026-06-29T15:00:00");
  });
  it("unescapes summary and location", () => {
    expect(events[0].summary).toBe("Camp: Pit Stop Pals, ages 6-9");
    expect(events[0].location).toBe("117 Museum St\nOwls Head, ME");
  });
  it("keeps the per-event URL", () => {
    expect(events[0].url).toBe("https://owlshead.org/event/camp-pit-stop-pals/2026-06-29/");
  });
  it("parses an all-day VALUE=DATE start", () => {
    expect(events[1].start).toBe("2026-07-04");
    expect(events[1].end).toBeNull();
  });
});

describe("icalCandidates", () => {
  it("includes the url itself plus ECP variants, deduped and capped", () => {
    const c = icalCandidates("https://owlshead.org/events/");
    expect(c[0]).toBe("https://owlshead.org/events/");
    expect(c).toContain("https://owlshead.org/?post_type=tribe_events&ical=1");
    expect(c.some((u) => u.includes("ical=1"))).toBe(true);
    expect(c.length).toBeLessThanOrEqual(5);
    expect(new Set(c).size).toBe(c.length);
  });
  it("returns just the raw url when it cannot be parsed", () => {
    expect(icalCandidates("not a url")).toEqual(["not a url"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/agents && npx vitest run src/ical.test.ts`
Expected: FAIL ("Cannot find module './ical'").

- [ ] **Step 3: Implement the parser**

Create `packages/agents/src/ical.ts`:

```ts
// iCal (RFC 5545) parsing + feed fetch for the fetch_ical tool. Pure logic +
// HTTP only (no SDK/db imports beyond the shared ToolTextResult type), mirroring
// overpass.ts so it stays unit-testable via an injected fetchImpl.
import type { ToolTextResult } from "./overpass";

export interface ICalEvent {
  summary: string | null;
  start: string | null; // ISO 8601 wall-clock
  end: string | null;
  url: string | null;
  location: string | null;
}

export function isVCalendar(text: string): boolean {
  return /BEGIN:VCALENDAR/i.test(text);
}

// RFC 5545 line unfolding: a line starting with a space or tab continues the
// previous one (strip the single leading whitespace char).
function unfold(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (out.length && (line.startsWith(" ") || line.startsWith("\t"))) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

function unescapeText(v: string): string {
  return v.replace(/\\([\\;,nN])/g, (_, c) => (c === "n" || c === "N" ? "\n" : c));
}

// ICS datetime → ISO. Handles YYYYMMDD, YYYYMMDDTHHMMSS, and a trailing Z.
function toIso(value: string): string | null {
  const v = value.trim();
  let m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] ?? ""}`;
  m = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

export function parseICal(text: string): ICalEvent[] {
  const events: ICalEvent[] = [];
  let cur: Partial<ICalEvent> | null = null;
  for (const line of unfold(text)) {
    if (line === "BEGIN:VEVENT") {
      cur = {};
      continue;
    }
    if (line === "END:VEVENT") {
      if (cur && cur.start) {
        events.push({
          summary: cur.summary ?? null,
          start: cur.start,
          end: cur.end ?? null,
          url: cur.url ?? null,
          location: cur.location ?? null,
        });
      }
      cur = null;
      continue;
    }
    if (!cur) continue;
    const ci = line.indexOf(":");
    if (ci === -1) continue;
    const name = line.slice(0, ci).split(";")[0].toUpperCase();
    const value = line.slice(ci + 1);
    switch (name) {
      case "SUMMARY":
        cur.summary = unescapeText(value);
        break;
      case "DTSTART":
        cur.start = toIso(value);
        break;
      case "DTEND":
        cur.end = toIso(value);
        break;
      case "URL":
        cur.url = value.trim();
        break;
      case "LOCATION":
        cur.location = unescapeText(value);
        break;
    }
  }
  return events;
}

// The Events Calendar (ECP) iCal feed lives at predictable URLs. Probe the URL
// as given first, then common ECP forms derived from its origin.
export function icalCandidates(url: string): string[] {
  const out: string[] = [];
  const add = (u: string) => {
    if (u && !out.includes(u)) out.push(u);
  };
  add(url);
  try {
    const u = new URL(url);
    const withIcal = new URL(url);
    withIcal.searchParams.set("ical", "1");
    add(withIcal.toString());
    add(`${u.origin}/events/?ical=1`);
    add(`${u.origin}/?post_type=tribe_events&ical=1`);
    add(`${u.origin}/events/list/?ical=1`);
  } catch {
    // not a parseable URL — leave just the raw string
  }
  return out.slice(0, 5);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/agents && npx vitest run src/ical.test.ts`
Expected: PASS. Also `cd packages/agents && npx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/ical.ts packages/agents/src/ical.test.ts
git commit -m "feat(agents): iCal parser + ECP feed-URL candidates"
```

---

### Task 2: feed fetch + tool-result formatter

**Files:**
- Modify: `packages/agents/src/ical.ts` (append `ICAL_UA`, `runIcalFetch`, `formatIcalResult`)
- Test: `packages/agents/src/ical.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: `parseICal`, `isVCalendar`, `icalCandidates` (Task 1); `ToolTextResult` from `./overpass`.
- Produces:
  - `type IcalFetchResult = { ok: true; feedUrl: string; events: ICalEvent[] } | { ok: false; error: string; status?: number }`
  - `runIcalFetch(url: string, fetchImpl?: typeof fetch): Promise<IcalFetchResult>`
  - `formatIcalResult(result: IcalFetchResult, limit?: number, today?: string): ToolTextResult`

- [ ] **Step 1: Write the failing tests**

Append to `packages/agents/src/ical.test.ts`:

```ts
import { formatIcalResult, runIcalFetch } from "./ical";

// Minimal fetch stub: maps url -> {status, body}.
function stubFetch(routes: Record<string, { status: number; body: string }>): typeof fetch {
  return (async (input: any) => {
    const url = String(input);
    const r = routes[url];
    if (!r) return { ok: false, status: 404, text: async () => "not found" } as any;
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => r.body } as any;
  }) as unknown as typeof fetch;
}

const FEED = [
  "BEGIN:VCALENDAR",
  "BEGIN:VEVENT",
  "SUMMARY:Past Event",
  "DTSTART:20200101T100000",
  "URL:https://x.org/event/past/",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "SUMMARY:Future Event",
  "DTSTART:20260704T100000",
  "URL:https://x.org/event/future/",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

describe("runIcalFetch", () => {
  it("returns the first candidate that yields a VCALENDAR", async () => {
    const fetchImpl = stubFetch({
      "https://x.org/events/": { status: 403, body: "Forbidden" },
      "https://x.org/events/?ical=1": { status: 200, body: FEED },
    });
    const r = await runIcalFetch("https://x.org/events/", fetchImpl);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.feedUrl).toBe("https://x.org/events/?ical=1");
      expect(r.events).toHaveLength(2);
    }
  });

  it("reports the last error when no candidate is a feed", async () => {
    const fetchImpl = stubFetch({}); // every url -> 404
    const r = await runIcalFetch("https://x.org/events/", fetchImpl);
    expect(r.ok).toBe(false);
  });
});

describe("formatIcalResult", () => {
  it("keeps only upcoming events, sorted, and projects fields", () => {
    const result = { ok: true as const, feedUrl: "https://x.org/events/?ical=1", events: parseICal(FEED) };
    const out = formatIcalResult(result, 30, "2026-06-21");
    const payload = JSON.parse(out.content[0].text);
    expect(out.isError).toBeUndefined();
    expect(payload.matched).toBe(1); // past event filtered out
    expect(payload.events[0].summary).toBe("Future Event");
    expect(payload.feedUrl).toBe("https://x.org/events/?ical=1");
  });

  it("flags a failed fetch as an error result", () => {
    const out = formatIcalResult({ ok: false, error: "HTTP 403", status: 403 });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content[0].text).status).toBe(403);
  });

  it("caps and flags truncation", () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      ["BEGIN:VEVENT", `SUMMARY:E${i}`, `DTSTART:2026070${i + 1}T100000`, "END:VEVENT"].join("\r\n"),
    ).join("\r\n");
    const body = `BEGIN:VCALENDAR\r\n${many}\r\nEND:VCALENDAR`;
    const out = formatIcalResult({ ok: true, feedUrl: "f", events: parseICal(body) }, 2, "2026-06-21");
    const payload = JSON.parse(out.content[0].text);
    expect(payload.returned).toBe(2);
    expect(payload.truncated).toBe(true);
  });
});
```

(`parseICal` is already imported from the Task 1 test block at the top of the file.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/agents && npx vitest run src/ical.test.ts`
Expected: FAIL ("runIcalFetch is not exported" / "formatIcalResult is not exported").

- [ ] **Step 3: Implement fetch + formatter**

Append to `packages/agents/src/ical.ts`:

```ts
const ICAL_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/124.0 Safari/537.36 LocalFinds/1.0 (personal local-discovery feed)";

export type IcalFetchResult =
  | { ok: true; feedUrl: string; events: ICalEvent[] }
  | { ok: false; error: string; status?: number };

// Try each candidate; the first 2xx response whose body is a VCALENDAR wins.
export async function runIcalFetch(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<IcalFetchResult> {
  let last: IcalFetchResult = { ok: false, error: "no candidates" };
  for (const candidate of icalCandidates(url)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25_000);
    try {
      const res = await fetchImpl(candidate, {
        headers: { "User-Agent": ICAL_UA },
        redirect: "follow",
        signal: controller.signal,
      });
      if (!res.ok) {
        last = { ok: false, error: `HTTP ${res.status}`, status: res.status };
        continue;
      }
      const body = await res.text();
      if (!isVCalendar(body)) {
        last = { ok: false, error: "response was not an iCalendar feed" };
        continue;
      }
      return { ok: true, feedUrl: candidate, events: parseICal(body) };
    } catch (err) {
      last = { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  }
  return last;
}

// Project a fetch result into the fetch_ical tool's response: upcoming events
// only (start >= today, date-prefix compare), sorted ascending, capped. A failed
// fetch is flagged isError:true so it surfaces in the run's warning count.
export function formatIcalResult(
  result: IcalFetchResult,
  limit?: number,
  today: string = new Date().toISOString().slice(0, 10),
): ToolTextResult {
  if (!result.ok) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: result.error, status: result.status }) }],
      isError: true,
    };
  }
  const cap = Math.min(Math.max(limit ?? 30, 1), 60);
  const upcoming = result.events
    .filter((e): e is ICalEvent & { start: string } => !!e.start && e.start.slice(0, 10) >= today)
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  const events = upcoming.slice(0, cap);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          feedUrl: result.feedUrl,
          matched: upcoming.length,
          returned: events.length,
          truncated: upcoming.length > cap,
          events,
        }),
      },
    ],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/agents && npx vitest run src/ical.test.ts`
Expected: PASS (all Task 1 + Task 2 tests). Also `cd packages/agents && npx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/ical.ts packages/agents/src/ical.test.ts
git commit -m "feat(agents): iCal feed fetch (candidate probing) + tool-result formatter"
```

---

### Task 3: `sources.ical_url` column + `upsertSource` support

**Files:**
- Modify: `packages/db/src/schema.ts` (`sources` table)
- Modify: `packages/db/src/queries.ts` (`UpsertSourceInput`, `upsertSource`)
- Test: `packages/db/src/queries.test.ts` (append a `describe`)

**Interfaces:**
- Produces: `sources.icalUrl` column (nullable); `UpsertSourceInput.icalUrl?: string` written through by `upsertSource`. `listSources()` already returns full rows, so `ical_url` is included automatically.

- [ ] **Step 1: Add the column to `schema.ts`**

In the `sources` table definition, add an `icalUrl` column after `notesPath`:

```ts
  notesPath: text("notes_path"),
  icalUrl: text("ical_url"),
```

- [ ] **Step 2: Thread `icalUrl` through `upsertSource`**

In `packages/db/src/queries.ts`, add the field to `UpsertSourceInput`:

```ts
export interface UpsertSourceInput {
  url: string;
  name?: string;
  status?: "active" | "paused" | "dead";
  qualityScore?: number;
  notesPath?: string;
  icalUrl?: string;
  addedBy: string;
}
```

In `upsertSource`, set it on update and include it on insert:

```ts
  if (input.notesPath !== undefined) set.notesPath = input.notesPath;
  if (input.icalUrl !== undefined) set.icalUrl = input.icalUrl;
```

```ts
    .values({
      url: input.url,
      name: input.name,
      status: input.status ?? "active",
      qualityScore: input.qualityScore,
      notesPath: input.notesPath,
      icalUrl: input.icalUrl,
      addedBy: input.addedBy,
      createdAt: now,
      lastCheckedAt: now,
    })
```

- [ ] **Step 3: Write the failing test**

Append to `packages/db/src/queries.test.ts`:

```ts
describe("upsertSource ical_url", () => {
  it("stores and updates ical_url", () => {
    q.upsertSource({ url: "https://venue.org/", addedBy: "test" });
    q.upsertSource({
      url: "https://venue.org/",
      icalUrl: "https://venue.org/events/?ical=1",
      status: "active",
      addedBy: "test",
    });
    const row = q.listSources().find((s) => s.url === "https://venue.org/");
    expect(row?.icalUrl).toBe("https://venue.org/events/?ical=1");
    expect(row?.status).toBe("active");
  });
});
```

- [ ] **Step 4: Run test (fails → push schema → passes)**

Run: `cd packages/db && npx vitest run src/queries.test.ts -t "ical_url"`
The harness `beforeAll` runs `drizzle-kit push --force`, so the column is created from `schema.ts`. Expected: PASS once Steps 1-2 are in. (If it fails with "no such column", the schema edit in Step 1 is missing.)

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema.ts packages/db/src/queries.ts packages/db/src/queries.test.ts
git commit -m "feat(db): add sources.ical_url, thread through upsertSource"
```

---

### Task 4: `fetch_ical` tool + `upsert_source` ical_url param + allowedTools

**Files:**
- Modify: `packages/agents/src/mcp-tools.ts` (import ical helpers; `SourceUpsertArgs`; `recordSourceUpsert`; `upsert_source` schema; new `fetch_ical` tool)
- Modify: `packages/agents/src/agents/scout.ts` (allowedTools)
- Modify: `packages/agents/src/agents/source-keeper.ts` (allowedTools)
- Test: `packages/agents/src/mcp-tools.test.ts` (append a test)

**Interfaces:**
- Consumes: `runIcalFetch`, `formatIcalResult` (Task 2); `upsertSource` with `icalUrl` (Task 3).
- Produces: `mcp__localfinds__fetch_ical` tool (input `{ url: string; limit?: number }`); `upsert_source` gains an `ical_url` input; `SourceUpsertArgs.ical_url?: string`.

- [ ] **Step 1: Write the failing test**

`mcp-tools.test.ts` already has the `beforeAll` that sets `LOCALFINDS_DATA_DIR`, runs `execSync("npx drizzle-kit push --force", …)`, and assigns the module-scoped `recordSourceUpsert` via dynamic import. DO NOT add static top-level imports of `./mcp-tools` or `@localfinds/db` — that would load the db before the temp data dir is set, breaking the file's pattern. Reuse the existing `recordSourceUpsert` binding and dynamically import `listSources` inside the async test. Append this `describe`:

```ts
describe("recordSourceUpsert ical_url", () => {
  it("passes ical_url through to the sources row", async () => {
    const { listSources } = await import("@localfinds/db");
    const counters = { added: 0, updated: 0 };
    recordSourceUpsert(
      { url: "https://feedvenue.org/", ical_url: "https://feedvenue.org/events/?ical=1" },
      "source-keeper",
      counters,
    );
    const row = listSources().find((s) => s.url === "https://feedvenue.org/");
    expect(row?.icalUrl).toBe("https://feedvenue.org/events/?ical=1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/agents && npx vitest run src/mcp-tools.test.ts -t "ical_url"`
Expected: FAIL — `ical_url` not accepted by `SourceUpsertArgs` / not written.

- [ ] **Step 3: Add `ical_url` to source upsert**

In `packages/agents/src/mcp-tools.ts`, extend `SourceUpsertArgs`:

```ts
export interface SourceUpsertArgs {
  url: string;
  name?: string;
  status?: "active" | "paused" | "dead";
  quality_score?: number;
  notes_path?: string;
  ical_url?: string;
}
```

In `recordSourceUpsert`, pass it through:

```ts
  const result = upsertSource({
    url: args.url,
    name: args.name,
    status: args.status,
    qualityScore: args.quality_score,
    notesPath: args.notes_path,
    icalUrl: args.ical_url,
    addedBy: agent,
  });
```

Add the field to the `upsert_source` tool's input schema (the `z.object` passed to `tool("upsert_source", …)`):

```ts
          ical_url: z
            .string()
            .optional()
            .describe("iCal feed URL for this source, if it has one (e.g. The Events Calendar ?ical=1)"),
```

- [ ] **Step 4: Add the `fetch_ical` tool**

At the top of `mcp-tools.ts`, import the helpers:

```ts
import { formatIcalResult, runIcalFetch } from "./ical";
```

Add the tool inside `buildLocalfindsServer`'s `tools: [...]` array (next to `overpass_query`):

```ts
      tool(
        "fetch_ical",
        "Fetch a venue's iCal calendar feed and return its upcoming events as structured data (summary, start, end, url, location). Pass the venue's site or events-page URL — the tool probes the common feed URLs (e.g. ?ical=1) itself and returns the resolved feedUrl. Works on many sites whose HTML blocks WebFetch (403). Use the per-event url when saving a find.",
        {
          url: z.string().describe("The venue's site, events-page, or known iCal feed URL"),
          limit: z.number().optional().describe("Max upcoming events to return, default 30, capped at 60"),
        },
        async (args) => formatIcalResult(await runIcalFetch(args.url), args.limit),
      ),
```

- [ ] **Step 5: Add the tool to both agents' allowedTools**

In `packages/agents/src/agents/scout.ts`, add to the `allowedTools` array:

```ts
    "mcp__localfinds__fetch_ical",
```

In `packages/agents/src/agents/source-keeper.ts`, add to its `allowedTools` array:

```ts
    "mcp__localfinds__fetch_ical",
```

- [ ] **Step 6: Run tests + typecheck**

Run: `cd packages/agents && npx vitest run src/mcp-tools.test.ts -t "ical_url"` → PASS.
Run: `cd packages/agents && npx tsc --noEmit` → clean.
Run: `cd packages/agents && npx vitest run` → all pass.

- [ ] **Step 7: Commit**

```bash
git add packages/agents/src/mcp-tools.ts packages/agents/src/mcp-tools.test.ts packages/agents/src/agents/scout.ts packages/agents/src/agents/source-keeper.ts
git commit -m "feat(agents): fetch_ical tool + upsert_source ical_url; grant to scout & source-keeper"
```

---

### Task 5: agent prompts — source-keeper discovery + scout consumption

**Files:**
- Modify: `packages/agents/src/agents/source-keeper.ts` (`buildTaskPrompt`)
- Modify: `packages/agents/src/agents/scout.ts` (`buildTaskPrompt`)

**Interfaces:**
- Consumes: the `fetch_ical` tool + `ical_url` upsert param (Task 4); `list_sources` returns `ical_url` (Task 3). No new exports.

- [ ] **Step 1: source-keeper — discover & record feeds**

In `source-keeper.ts` `buildTaskPrompt`, replace step 3 and the blocked-venue bullet in step 4 to add iCal discovery. Change step 3 to:

```
3. Re-check the 3-5 stalest sources (oldest last_checked_at): fetch their news/events pages, then update notes/sites/<host>.md and call upsert_source (which bumps last_checked_at) with any status or quality changes. If a site is gone, set status "dead" and say why in its note.
   - For any source that does not already have an ical_url, call fetch_ical on its URL. If it returns a feedUrl, record it: upsert_source with ical_url set to that feedUrl AND status "active" — a calendar feed is reachable even when the site's HTML blocks fetches (403), so a feed-backed source should not stay paused. Note the feed URL in its site note.
```

And change the blocked-venue bullet in step 4 to try the feed first:

```
   - If a candidate is a real, in-scope venue you genuinely can't fetch (e.g. HTTP 403, login wall): first try fetch_ical on its URL — many such sites still expose a working calendar feed. If a feed is found, register the source active with ical_url set. Only if there is no feed, register it with status "paused" and notes_path pointing at its note. Don't leave a blocked venue as a note-only file: a paused source is tracked and rotated like any other.
```

- [ ] **Step 2: scout — consume feeds**

In `scout.ts` `buildTaskPrompt`, add a new sub-bullet under step 4 (after the list_businesses bullet):

```
   - Check registered sources that have an ical_url (from list_sources): call fetch_ical with that ical_url to get their upcoming events directly as structured data. This is the reliable way to cover venues whose HTML blocks fetching. Each returned event has its own url — use it when you save_find. Feed events are confirmed at the venue's own calendar, so they satisfy the honesty rule without a separate fetch.
```

- [ ] **Step 3: Typecheck + full suite (no behavior unit-tested here)**

Run: `cd packages/agents && npx tsc --noEmit` → clean.
Run: `cd packages/agents && npx vitest run` → all pass (prompt strings only; nothing should regress).

- [ ] **Step 4: Commit**

```bash
git add packages/agents/src/agents/source-keeper.ts packages/agents/src/agents/scout.ts
git commit -m "feat(agents): prompt source-keeper to discover iCal feeds and scout to consume them"
```

- [ ] **Step 5: Manual verification (controller-coordinated; the agent loop is not unit-tested)**

Push the schema to the dev DB, then confirm the pipeline against owlshead. NOTE: running `drizzle-kit push` on `data/localfinds.db` from THIS branch reconciles the DB to this branch's schema — it adds `sources.ical_url`. (This branch is off main and has no `fetches` table; if the local DB currently has one from the other branch, prefer verifying against a throwaway DB via `LOCALFINDS_DATA_DIR` to avoid a destructive drop. Controller decides.)

```bash
cd packages/db && npx drizzle-kit push && cd ../..
# Confirm a feed resolves end-to-end (no agent, no API spend):
node -e "import('@localfinds/agents/dist/ical.js').catch(()=>{}); " 2>/dev/null || true
```
Then, controller-coordinated (costs ~$1 each): a source-keeper run should discover owlshead's feed and set its ical_url + status active; a following scout run should fetch_ical it and save owlshead events. Verify with:
```bash
sqlite3 data/localfinds.db "SELECT url, status, ical_url FROM sources WHERE url LIKE '%owlshead%';"
```

---

## Self-Review notes (for the implementer)

- **Spec coverage:** Task 1 → parser + candidates; Task 2 → `runIcalFetch` (probing) + `formatIcalResult` (upcoming filter/cap/isError); Task 3 → `sources.ical_url` + upsertSource; Task 4 → `fetch_ical` tool + `upsert_source` ical_url + allowedTools (scout & source-keeper); Task 5 → discovery + consumption prompts + auto-activate. RRULE expansion and UI are intentionally absent (out of scope).
- **Type consistency:** `ICalEvent` shape is identical across `parseICal`, `runIcalFetch`, and `formatIcalResult`. `IcalFetchResult` is the single return type shared by `runIcalFetch`/`formatIcalResult`. `icalUrl` (db/camelCase) vs `ical_url` (tool/snake_case) boundary is crossed only in `recordSourceUpsert` (Task 4), matching the existing `notes_path`→`notesPath` convention.
- **Determinism:** `formatIcalResult` takes an injectable `today` so the upcoming-filter tests don't depend on the clock.
```
