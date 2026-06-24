# Interviewer Agent — ICP + targeting setup

_Status: **design plan, revised 2026-06-24 (v3)** against `main`. Supersedes the in-session
"shimmering pinwheel" plan and the same-day v2 refresh. Re-scoped around a **build-interviewer-first**
flow with a **user-chosen interview path** (interactive vs. prepared questionnaire). Code anchors and
SDK behavior re-verified against the installed tree (`@anthropic-ai/claude-agent-sdk@0.3.175`). No
interviewer code written yet._

## Evaluation — plan vs. current state (verified 2026-06-24)

The original plan rested on two premises: (1) the prospector saves **zero leads** because its ICP is
an empty placeholder, and (2) the structured targeting config doesn't exist yet. Premise (1) **still
holds**; premise (2) **no longer holds** — the config is real and hand-tuned. Both re-verified:

| Plan artifact | Planned | Current state (verified) | Verdict |
|---|---|---|---|
| `region.md` | interviewer writes it | **Exists, real** — `name: "Rockland, Maine"`, Knox County prose | ✅ done by hand |
| `towns.json` | interviewer geocodes + writes it | **Exists, real** — 19 towns, real `[s,w,n,e]` bboxes, only Rockland `primary` | ✅ done by hand/script |
| `categories.json` | interviewer writes it | **Exists, real** — OSM `key=value` tiers, `default_tier:3`, `hide_in_directory` | ✅ done by hand |
| `town-boundaries.json` (map polygons) | "remind user to run `boundaries:fetch`" | **Exists** — polygons already fetched (matched to `towns.json`) | ✅ done |
| `profile.md` (ICP) | interviewer writes it | **Byte-identical to `.example`** — 7 `(e.g …)` markers, untouched | ❌ **the blocker** |
| Prospector leads | success criterion: N leads saved | DB `finds`: **84 `event`, 0 `lead`** | ❌ unmet |
| `geocode.ts`, journal, tools, `agents/interviewer.ts`, `interview.ts` | create | none exist | ❌ 0% built |
| db config **writers** | add to `config.ts` | none — only readers exist | ❌ 0% built |
| `sanitizedEnv` export | export for reuse | still **private** (`run-agent.ts:91`) | ❌ |
| `interview` npm script | add | absent in both `package.json`s | ❌ |

**Code anchors are accurate** (verified): `config.ts` has `readRegionConfig`/`readTownsConfig`/
`readCategoryConfig`, the path helpers, the private `isValidTownBox`, the `TownBox` shape, the bbox
order comment at `:113` (`[south, west, north, east]`), and `tierOf` (a method on the object
`readCategoryConfig` returns). `agentWorkspaceDir` lives in `paths.ts` and is re-exported via
`index.ts`'s `export * from "./config"`/`"./paths"`. `run-agent.ts` hard-requires `region.md`
(`:147`), reads `profile.md` (`:155`), bans `AskUserQuestion` + `permissionMode:"bypassPermissions"`
(`:211`/`:216`), and `sanitizedEnv` is private at `:91`. `overpass.ts` has the injectable-`fetchImpl`
pattern.

**SDK behavior verified (the central de-risk):** `@anthropic-ai/claude-agent-sdk@0.3.175` documents
`CLAUDE_CODE_STREAM_CLOSE_TIMEOUT` for exactly our case — `sdk.d.ts:483`: *"If your SDK MCP calls will
run longer than 60s, override `CLAUDE_CODE_STREAM_CLOSE_TIMEOUT`."* So a blocking `ask_user` tool is a
supported pattern (default 60s, raise it). Streaming-input (`query(AsyncIterable<SDKUserMessage>)`,
`:2488`) is real as a fallback. The SDK **also ships first-class MCP elicitation** (`ElicitationRequest`
= "asking the SDK consumer for user input," with a `'form'` mode for structured input — `sdk.d.ts:569`,
hook events at `:802`) — the protocol-native "server asks the human and waits," which maps directly
onto `ask_user({question, choices})`. **Evaluate elicitation vs. the blocking tool in the spike**
(below).

**One correction to the v2 premise:** `fetch-town-boundaries.mjs` does **not** read Nominatim's
`boundingbox` — it requests `polygon_geojson=1` and picks a result via an `inBbox` containment check
against the *existing* `towns.json` bbox (`:73–91`). So the new `geocode.ts` (which would use
`boundingbox`) is **new disambiguation logic, not a mirror** of the existing script — they can pick
different OSM entities for the same town. This feeds the bbox-preservation fix in Step 1.

## The flow — cold-start onboarding, three steps

A **cold user has no `profile.md`**. The interviewer is the only thing that builds one — **there are
no handmade prospector profiles** — so the first lead generation can only happen *after* the
interviewer has run. The cold-start sequence:

1. **Build the interviewer** — the engine: db config writers (the durable foundation), the geocoder,
   the two interview-path runners, and the four config tools.
2. **Run the interviewer to build `profile.md`** (+ structured config). The user **chooses a path**:
   - **(a) Interactive** — a live, adaptive conversation. Opens with one heads-up line:
     *"Grab a coffee first — this takes about 5–10 minutes."* After that there is **no per-question
     timer and no nudges** (calm by construction). The agent asks follow-ups → **more targeted**
     result.
   - **(b) Prepared questionnaire** — **answer at your leisure**, async. The interviewer writes a
     questionnaire file; you fill it in whenever; re-running reads your answers and generates the
     config + ICP in one pass. No live session, no time pressure, no blocking tool — but **less
     targeted** (fixed questions, no adaptive follow-up).
3. **Run the prospector (one-shot) on the interviewer-built `profile.md`** → the **first** leads.
   `npm run agent -- prospector`. The success criterion (`finds` is at 84 `event`, **0 `lead`** until
   the interviewer produces an ICP).

## Decisions

- **Surface:** CLI now, built as a **surface-agnostic engine** (`InterviewIO` seam) so a future web
  chat page reuses it.
- **Scope:** the interviewer writes BOTH the ICP prose AND the structured config, so the
  towns/categories drive the prospector's `list_businesses` filters.
- **Two paths, user-chosen (new in v3):** mode is selected by a single plain-`readline` prompt at
  launch (or a `--prepared` flag) — **before** any `query()` runs, so the mode choice itself never
  touches the SDK or any timeout. Interactive = live + adaptive (+ one upfront time heads-up).
  Prepared = file-based questionnaire, async, fire-and-generate.
- **Calm within a path:** no countdown, no "need more time?" nudge, no pre-brief gate during the
  interview. Interactive opens with exactly one expectation-setting line; prepared has no time
  pressure at all.
- **Cost & UX:** `effort:"medium"` (snappy interactive turns + lower cost; see Risks), and **no
  `maxBudgetUsd` cap** for the interactive runner — a human-paced interview can't run away, and a
  mid-interview budget kill is a bad UX. (Prepared-mode generation may use a higher effort if needed
  since nobody's waiting live.)
- **Refine-over-time loop: deferred** (see *Out of scope*); engine kept refinement-ready (read
  existing files first, edit rather than blind-overwrite).

## Step 1 — the engine

### 1a. db config writers (the durable foundation)

Add writers next to the readers in **`packages/db/src/config.ts`**, round-tripping through the exact
shapes the prospector reads, reusing the private `isValidTownBox`:

- `writeIcpProfile(markdown)` → `path.join(agentWorkspaceDir("prospector"), "profile.md")` (the exact
  path `run-agent.ts:155` reads); `mkdirSync` the workspace + `notes/` first.
- `readIcpProfile()` → current ICP or `null`. **Robust placeholder detection (Issue 7 fix):** do NOT
  test for the `(e.g` substring (it appears in legitimate prose). Treat the profile as "untouched" if
  it is **byte-identical to `profile.md.example`** (today's exact state), or add a sentinel comment to
  the `.example` (`<!-- TEMPLATE: replace every section before use -->`) that the interviewer strips
  on write and detect *that*. Return `null` only on those signals.
- `writeRegionConfig({ name, coverageMarkdown })` → `regionConfigPath()`; round-trip via
  `readRegionConfig()` to assert `name` parses back.
- `writeTownsConfig(towns: TownBox[])` → `townsConfigPath()`; **throw** if any town fails
  `isValidTownBox` (surface a bad bbox, never silently drop).
- `writeCategoryConfig({ default_tier, hide_in_directory, tiers })` → `categoryConfigPath()`; reject
  any category not matching the `key=value` shape. **Validate the regex against every entry already in
  the live `categories.json` first** (the key side must allow whatever real OSM keys are in there — a
  writer that can't rewrite the config that's already shipping is the worst failure mode).

`index.ts` already re-exports `./config`, so the new functions flow through automatically. Because the
writers target real, already-populated files, they must use **read-validate-write** (edit-in-place)
semantics, never assume a blank slate.

### 1b. the geocoder

**`packages/agents/src/geocode.ts`** — pure Nominatim geocoder (HTTP only, no SDK/db imports; mirror
`overpass.ts`'s injectable-`fetchImpl`):

- `geocodeTown({ name, county?, state, query? }, fetchImpl?)` → `{ name, county?, bbox, lat, lng }` or
  `{ error }`. Same query string as `fetch-town-boundaries.mjs:54–62`. **Reads Nominatim's
  `boundingbox` `[south, north, west, east]` and reorders to the project's `[south, west, north,
  east]`** (`config.ts:113`) — i.e. `[nb[0], nb[2], nb[1], nb[3]]`. *(Easiest thing to get backwards
  — assert it in a test.)* Note this disambiguation ("prefer admin boundary, then any boundary, then
  first") differs from `fetch-town-boundaries.mjs`'s polygon-containment pick, so the two can disagree
  — which is exactly why `set_towns` must **not** re-geocode unchanged towns (below).
- `geocodeTowns(inputs, { throttleMs = 1100 })` — sequential with `sleep` (Nominatim ≤1 req/s); per-
  town results so one failure doesn't abort the batch.

### 1c. interactivity engine + tools

**The seam:**

```ts
export interface InterviewIO {
  ask(question: string, opts?: { choices?: string[] }): Promise<string>; // blocks until answered — no timeout
  say(message: string): void;
}
export function buildInterviewerServer(io: InterviewIO): McpServerConfig
```

**`packages/agents/src/interview-tools.ts`** — `buildInterviewerServer(io)` via `createSdkMcpServer` +
`tool()`. Tools (each async, `asText({...})`):

- `ask_user` `{ question, choices? }` → `io.ask(...)` — the live interactivity seam (interactive path
  only; in prepared mode `io.ask` is never invoked).
- `say` `{ message }` → `io.say(...)`.
- `geocode_town` `{ name, county?, query? }` → preview a town before committing.
- `read_current_config` `{}` → `{ region, towns, categories, icp }` from the readers (or nulls).
- `set_region`, `set_towns`, `set_categories`, `write_icp` — the four writers (table below).

**The four config writers:**

| Tool | Input (Zod, abbrev.) | db helper | Writes |
|---|---|---|---|
| `set_region` | `{ name, coverage_markdown }` | `writeRegionConfig` | `data/config/region.md` |
| `set_towns` | `{ towns: { name, county?, primary?, query? }[] }` | derive state from `readRegionConfig().name`; **preserve existing bboxes by name** (below) → `writeTownsConfig` | `data/config/towns.json` |
| `set_categories` | `{ default_tier, hide_tier4, hide_chains, tiers }` | `writeCategoryConfig` | `data/config/categories.json` |
| `write_icp` | `{ markdown }` | `writeIcpProfile` | `data/agents/prospector/profile.md` |

**`set_towns` must preserve hand-tuned bboxes (Issue 3 fix — the key data-safety rule).** The current
`towns.json` holds 19 verified bboxes, and `town-boundaries.json` polygons were fetched to match them.
`set_towns` must:
1. Load the current `towns.json`.
2. For each input town that **already exists by name** with a valid bbox, **keep the existing bbox**
   (do not re-geocode — re-geocoding would replace tuned values and may pick a different OSM entity).
3. Geocode **only genuinely new or renamed** towns (via `geocodeTowns`).
4. Return per-town `{ name, bbox | error }` so the agent can re-ask for towns that didn't geocode.
5. If any town's coordinates changed, **`say` a reminder to re-run `npm run boundaries:fetch`** (so
   the map polygons resync).

It errors early if region isn't set; the agent never supplies or sees coordinates.

**Confirm-before-write shows a real diff (Issue 8 fix).** Before any of the four writes commit, the
flow must present a **literal before/after diff per file** (current file content vs. proposed
content), not just a prose summary — because these files are hand-tuned and `sync-content.sh` rsyncs
`data/` to the live site, so a silent drop/rename must be visible before the user confirms. One
confirm gate gathers all four diffs.

### 1d. the agent definition + runners

**`packages/agents/src/agents/interviewer.ts`** — the `AgentDefinition`: `name:"interviewer"`,
`model:"claude-sonnet-4-6"`, **`effort:"medium"`** (Issue 5: good interactive latency + lower cost;
all existing tuned agents dial effort *down*, none use high), `allowedTools` = the
`mcp__interviewer__*` tools, plus a systemPrompt per path. No `buildTaskPrompt`.

**`packages/agents/src/interview.ts`** — the `npm run interview` entry. First, **select the path**
(plain `node:readline` prompt or `--prepared` flag) — pre-agent, no SDK, no timeout. Then:

- **Interactive path:** print the coffee/5–10-min heads-up. Build the readline `io` (each `ask`/`say`
  journals — see Durability). On startup read the journal + `read_current_config`; if a prior
  incomplete interactive session exists, seed `summarizeForResume(...)`. Run one `query()` (options
  mirrored from `run-agent.ts:201–218`: `model`, `effort:"medium"`, `env:` **`sanitizedEnv()` plus a
  generously raised `CLAUDE_CODE_STREAM_CLOSE_TIMEOUT`** — add a comment that this `CLAUDE_*` var is a
  deliberate re-add on top of the stripper, so nobody "cleans it up" (Issue 10), `settingSources:[]`,
  `settings:{autoMemoryEnabled:false}`, `permissionMode:"bypassPermissions"`,
  `mcpServers:{ interviewer: buildInterviewerServer(io) }`, `allowedTools`, generous `maxTurns` (~60),
  **no `maxBudgetUsd` cap** (Issue 6), `disallowedTools` locking out `Read/Write/Edit/Glob/Grep/
  WebSearch/WebFetch/Bash/Agent/Task/AskUserQuestion`). No path-guard hook, no `startRun`/`finishRun`,
  no workspace.
- **Prepared path:** if `questionnaire.md` is **absent or unfilled**, write the template
  (`data/agents/interviewer/questionnaire.md`: the fixed questions — what you offer, ideal customer,
  disqualifiers, towns w/ county, region coverage — with blank answer slots), tell the user to fill it
  and re-run, and exit. If it's **filled**, run **one non-interactive `query()`** that reads the
  answers (in the kickoff prompt), calls `geocode_town`/`set_*`/`write_icp`, shows the diff, and
  confirms via a single readline y/n. `io.ask` is never wired here; the agent makes best guesses on
  ambiguity (hence "less targeted").

**Spike first (Step 1 execution, before geocode/journal/writers are finished):** stand up a minimal
interactive `query()` with one blocking `ask_user`, raise `CLAUDE_CODE_STREAM_CLOSE_TIMEOUT`, and
confirm a multi-minute wait survives. In the same spike, try the **MCP elicitation `'form'`** path and
compare. Adopt whichever is cleaner; the `InterviewIO` seam, the four writers, and the geocoder are
identical either way. (The prepared path needs none of this — it's robust by construction.)

### 1e. durability & recovery — per path (Issue 9 cleanup)

- **Prepared path: durability is free.** The `questionnaire.md` file *is* the durable state — fill it
  over days, re-run any time. The only live LLM step (generation) is short and re-runnable. No journal.
- **Interactive path: journal + resume.** `packages/agents/src/interview-journal.ts`:
  - `appendEntry({ role, kind, text })` → one JSON line to `data/agents/interviewer/session.jsonl`
    (gitignored), **flushed synchronously** so an answer is on disk *before* `io.ask` returns.
  - `readJournal()` → ordered entries (or `[]`).
  - `summarizeForResume(entries)` → compact transcript seeded into a resumed run. **Must preserve the
    un-written answers specifically** (the only state living solely in the journal — config already
    written persists in the files; the readers pick it up on resume). Pure function; injectable.
  - We deliberately use journal-replay over the SDK's native session resume (`options.resume` +
    `session_id`) for **portability** to the future web surface and because we run with
    `settingSources:[]` / no CLI session storage. Note the trade-off in code.

**Files to modify:** `run-agent.ts` — export the private `sanitizedEnv` (`:91`) for reuse (one
definition, security-relevant). `packages/agents/package.json` — add `"interview": "tsx
src/interview.ts"`. root `package.json` — add `"interview": "npm -w @localfinds/agents run interview"`.

## Step 2 — run the interviewer to build `profile.md`

`npm run interview` → choose path → answer (live, or via the questionnaire file) → confirm the diffs
→ the four files are written. Interactive yields a more targeted ICP; prepared is faster to start and
async but less targeted. Either way the structured files are written first (`set_region` → `set_towns`
→ `set_categories`) then `write_icp`, referencing the same towns/categories so prose and config agree.

## Step 3 — run the prospector → the first leads (the success criterion)

Only possible after Step 2 has written a real `profile.md`. `npm run agent -- prospector
--max-turns 10 --max-budget-usd 0.50` → confirm `type:"lead"` rows appear in `finds` (was 0). This is
the **first** lead generation for this profile. If it yields nothing, the cause is either ICP quality
or an unexercised bug in the lead-save / `list_businesses` path — be ready to debug the prospector,
not just the ICP.

## Verification

**Unit (vitest) — test what we know the target is; defer the rest until a gap is confirmed (Issue 4):**
- `config.test.ts` — **round-trip the real, live config files**: read current `region.md`/`towns.json`/
  `categories.json` → write → read → assert unchanged (this is the known coverage target and catches a
  too-strict category regex, bbox-order, and ICP-path bugs); plus `writeTownsConfig` throws on a bad
  bbox; `set_towns` keeps an existing town's bbox and geocodes only a new one (fake geocoder);
  `readIcpProfile` returns null on the `.example`/sentinel and prose otherwise.
- `geocode.test.ts` — canned Nominatim payload (admin boundary + same-name decoy in another state):
  asserts the right pick and the `[s,n,w,e] → [s,w,n,e]` reorder explicitly.
- `interview-journal.test.ts` — `appendEntry` writes one durable JSON line, flushed before the call
  resolves; a partial journal feeds `summarizeForResume` and the summary includes the un-written
  answers.
- `interview-tools.test.ts` — fake `ask`/`say` + fake geocoder (zero network, readline, timers):
  scripted answers, `set_towns` preserves/extends correctly, `read_current_config` returns nulls then
  written values.
- Optional: assert `"interviewer"` is absent from `RUN_TARGETS` to document the intentional exclusion
  from the scheduled roster (do **not** touch `rosterOrder`/`registry`/`ROSTER`).

**End-to-end (manual):**
1. **Path choice:** `npm run interview` offers interactive vs. prepared.
2. **Interactive:** opens with the coffee/5–10-min line, then questions at a relaxed pace (no timer/
   nudge). **Mid-session Ctrl-C**, re-run → resumes from the journal, doesn't re-ask answered
   questions, earlier answers intact.
3. **Prepared:** first run writes `questionnaire.md`; fill it; re-run → generates config + ICP, shows
   diffs, single confirm.
4. **Diffs & round-trip:** the confirm step shows real before/after per file; after write, `region.md`
   has `name:`, `towns.json` parses with 4-number bboxes (unchanged towns keep their old bboxes),
   `categories.json` is `key=value`, `profile.md` has the six sections filled and matching the config.
5. **Idempotency:** re-run against populated config → reports existing config and offers to edit, not
   wipe.
6. **First leads:** `npm run agent -- prospector …` → `type:"lead"` rows appear in `finds` (was 0).
   The success criterion. If empty, debug ICP-quality vs. lead-path before assuming the ICP.

## Risks & sync-points

- **Prospector lead path is first exercised at Step 3.** Because there are no handmade profiles, the
  lead-save / `list_businesses` path is proven only after the interviewer builds a real ICP. If Step 3
  yields no leads, isolate ICP-quality vs. a lead-path bug before assuming the ICP is wrong.
- **Interactive interactivity mechanism.** Blocking `ask_user` is supported (`CLAUDE_CODE_STREAM_
  CLOSE_TIMEOUT`, default 60s → raise it); evaluate MCP elicitation `'form'` mode in the spike. The
  override is mandatory, not optional. The prepared path sidesteps this entirely.
- **`set_towns` clobbering hand-tuned bboxes (data corruption).** Mitigated by preserve-by-name +
  geocode-only-new + the `boundaries:fetch` reminder. Highest-value writer test covers it.
- **Editing already-populated, production-bound config.** `read_current_config` runs first; a confirm
  gate with real diffs precedes every write; writers use read-validate-write.
- **Config writes must round-trip through the readers** the prospector uses; the category writer's
  regex must accept everything already in the live `categories.json`.
- **Deploy propagation.** `sync-content.sh` rsyncs `data/` to prod, so a local interview's config + ICP
  ship to localfinds.peaslee.org on the next deploy — intended, but the interviewer is a local/dev
  tool, never run on the server.
- **PII / public repo.** All four target files are gitignored (`data/**` except `*.example`); never
  write into a `.example`; the ICP holds business specifics and stays in gitignored `data/`.

## Out of scope / next steps

- **"Dial-in over time" refine loop** — periodic sessions showing recent leads + thumbs/stars,
  editing the ICP's "Learned signals". Engine is refinement-ready; bolts on as a second mode reusing
  `buildInterviewerServer`.
- **Web chat front-end** — a thin sibling of `interview.ts` with a web-backed `io`.
- **Map polygons** — already fetched; the interviewer reminds the user to re-run `boundaries:fetch`
  after changing any town.
- **"Full user setup"** — extending the interview to scout interests / other agent profiles.
- **Sequencing (needs re-review).** After the pre-flight gate + Step 1, whether the interviewer is the
  highest-value next investment vs. other tracked directions (frontend/realtime, map Phase 2) is a
  prioritization call.
