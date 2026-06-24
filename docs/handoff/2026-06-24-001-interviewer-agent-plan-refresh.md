# Handoff — Interviewer Agent plan refresh (calm, journal-backed, resumable)

_Date: 2026-06-24 · Branch: `docs/prospector-agent-plan` · Session topic: read the "shimmering
pinwheel" plan, evaluate current state, save a refreshed plan, then redesign the interview UX._

## What was accomplished

1. **Recovered the "shimmering pinwheel" plan.** It was a plan-mode codename (no file by that name);
   the plan is the **Interviewer Agent** — an interactive CLI that elicits a user's targeting in
   plain language and writes both the ICP prose and the structured prospector config. Captured from
   session `971076c8-dae2-401e-acbb-6052fb3ffcbe.jsonl` (three `ExitPlanMode` iterations; the third
   was the most complete). Extracted dump saved at
   `…/1d29da0c-…/tool-results/bh7za9rdf.txt` (scratch — not committed).

2. **Evaluated the plan against current `main`.** Key finding — the landscape shifted since the plan
   was written:
   - The structured targeting config is now **fully populated, real data**: `data/config/region.md`
     ("Rockland, Maine", Knox County coverage), `towns.json` (19 towns with real `[s,w,n,e]` bboxes,
     `primary` set), `categories.json` (full OSM `key=value` tiers), and `town-boundaries.json` (map
     polygons already fetched). These were done by hand/script.
   - The **ICP `data/agents/prospector/profile.md` is still the placeholder template** (7 `(e.g …)`
     markers) — this is the **sole remaining blocker** to the prospector producing leads.
   - Confirmed via DB: `sqlite3 data/localfinds.db "SELECT type, COUNT(*) FROM finds GROUP BY type"`
     → `event|84`, **zero `lead` rows**. Success criterion (prospector saves leads) still unmet.
   - All code anchors the plan relies on are still valid: `config.ts` readers/paths/`isValidTownBox`/
     `TownBox`/`tierOf`; `run-agent.ts` still requires `region.md` (`:147`), reads `profile.md`
     (`:155`), bans `AskUserQuestion` (`:216`), runs one-shot `bypassPermissions` (`:211`);
     `sanitizedEnv` still private (`:91`).

3. **Wrote the refreshed plan:** `docs/plans/2026-06-24-interviewer-agent.md` (new, uncommitted).
   Re-scoped into three stages because the geocoding machinery is no longer the critical path:
   - **Stage 0 — unblock leads now (ICP only):** write a real `profile.md`, run the prospector,
     confirm `type:"lead"` rows. This is the real success criterion and proves the pipeline already
     works; can be done by hand or via Stage 1's `writeIcpProfile`.
   - **Stage 1 — db config writers** in `packages/db/src/config.ts` (`writeIcpProfile`/`readIcpProfile`
     first, then region/towns/categories), **edit-in-place** semantics (config is real now, not blank).
   - **Stage 2 — full interactive interviewer engine** (`geocode.ts`, `interview-tools.ts`,
     `agents/interviewer.ts`, `interview.ts`) with the surface-agnostic `InterviewIO` seam.

4. **Redesigned the interview UX per user direction** ("this isn't a pop quiz"). Removed the entire
   pacing apparatus and replaced it with a durability-first design (all folded into the same plan file):
   - **Removed:** countdown timer, "Do you need more time?" nudge, pre-brief/prep gate, the untimed
     "ready to start" gate, `timeout_seconds`/`timeoutSeconds` params, and the planned `countdown.ts`.
   - **Added:** `packages/agents/src/interview-journal.ts` — `appendEntry` writes one JSON line per
     prompt/answer to `data/agents/interviewer/session.jsonl`, **flushed synchronously so the answer
     is on disk before `io.ask` returns**; plus `readJournal()` and `summarizeForResume()`.
   - `io.ask` is now plain `readline.question(prompt)` — blocks indefinitely, no timer/abort.
   - **Resume on restart:** re-running `npm run interview` reads the journal + `read_current_config`
     and continues where it left off — no flags, no manual recovery, no change to the user's process.

## Key decisions

- **Substrate: keep the blocking `ask_user` MCP-tool seam + raise `CLAUDE_CODE_STREAM_CLOSE_TIMEOUT`**,
  rather than switching to SDK streaming-input mode. Rationale: smallest change, preserves the
  surface-agnostic `io` seam that makes the future web-chat port a drop-in swap. Streaming-input
  (`prompt` as `AsyncIterable<SDKUserMessage>`, wait sits between turns, no tool timeout) stays as a
  **documented fallback** if the raised timeout proves flaky. Spike the blocking path first.
- **Recoverability comes from the journal, not from keeping a connection alive.** The synchronous
  journal guarantees "nothing the user types is lost"; resume-from-journal guarantees "any disruption
  is recoverable." The raised timeout just keeps ordinary pauses smooth so disruption is the
  exception. This directly satisfies the user's two requirements.
- **Stage 0 front-loaded:** getting actual leads is cheap now (only the ICP is missing) and de-risks
  the larger interviewer build. Leads should not block on building the full engine.
- **Interviewer stays out of the scheduled roster** (interactive, runs before/around config). Do NOT
  touch `rosterOrder`/`registry` (`cli.ts`) or `ROSTER`/`runs.test.ts`.
- **Ruled out** rewriting `runAgent` to be interactive — it's one-shot/unattended by design and bans
  `AskUserQuestion`; the interviewer gets a separate entry point and runner.

## Important context for future sessions

- **Nothing committed this session.** Working tree: `README.md` modified (pre-existing, unrelated);
  untracked `docs/handoff/2026-06-23-001-localfinds-us-domain-parking.md` (pre-existing) and the new
  `docs/plans/2026-06-24-interviewer-agent.md` + this handoff. The interviewer is **0% implemented** —
  no code files exist yet.
- **The plan to execute is `docs/plans/2026-06-24-interviewer-agent.md`** (not the older
  `2026-06-22-polymorphic-finds-prospector-agent.md`, which is already implemented per commit
  `928eea8`). Start at Stage 0.
- **Fastest path to leads:** fill `data/agents/prospector/profile.md` (replace all 7 `(e.g …)`
  placeholders; reuse the six-section structure in `profile.md.example`; reference the towns in
  `towns.json` and tiers in `categories.json`), then
  `npm run agent -- prospector --max-turns 10 --max-budget-usd 0.50` and check for `type:"lead"` rows.
- **PII / public repo:** all four target files (`region.md`, `towns.json`, `categories.json`,
  `prospector/profile.md`) are under gitignored `data/` (only `*.example` committed). Never write into
  a `.example`. The new `session.jsonl` lands under gitignored `data/agents/interviewer/`.
- **Deploy note:** `scripts/deploy/sync-content.sh` rsyncs `data/` to prod, so a local interview's
  config + ICP ship to localfinds.peaslee.org on the next deploy. The interviewer is a local/dev tool,
  not run on the server.
- **Geocoder (`geocode.ts`) gotcha to assert in a test:** Nominatim returns `boundingbox` as
  `[south, north, west, east]`; the project uses `[south, west, north, east]` — reorder
  `[nb[0], nb[2], nb[1], nb[3]]`. ≥1.1s throttle, project User-Agent, `countrycodes=us`. Pattern
  mirrors `scripts/fetch-town-boundaries.mjs`. Less load-bearing now (current region already geocoded)
  but needed for edits/new regions.
