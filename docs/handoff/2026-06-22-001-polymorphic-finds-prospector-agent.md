# Handoff — 2026-06-22 — Polymorphic `finds` + `prospector` agent (design only)

A **planning session, no code written.** Output is a design plan answering "can we add a salesman/lead-gen
agent, and is the system too coupled to scout for it to fit?" Plan committed in-repo at
`docs/plans/2026-06-22-polymorphic-finds-prospector-agent.md` (new `docs/plans/` folder). Working copy also
at `~/.claude/plans/i-m-thinking-of-adding-greedy-coral.md`.

## What was accomplished

- **Coupling analysis (the actual question answered):** the four agents are **not** tightly coupled to
  scout or to each other. They never call each other — they communicate only through the shared SQLite
  store via one-directional reads (cartographer→`businesses`→scout/source-keeper; source-keeper→`sources`→scout;
  scout/source-keeper→`finds`→curator). The only `"scout"` hard-code in shared infra is the fetch-logging /
  host-block carve-out in `run-agent.ts` (gated `def.name === "scout"`), which a new agent simply wouldn't
  use. A 5th agent drops in for free: free-text `agent`/`added_by` columns (no enum), generic
  run/feedback/transcript machinery, and the `/agents` page iterates `ROSTER`. **The real coupling is
  system-to-domain** — everything downstream (`finds` → curator → feed UI → feedback) assumes a find is a
  "local current event for a personal feed."
- **Resolved by the user's reframe: a lead is a *type* of find.** Plan introduces a `type` discriminator on
  `finds` (`event` default, then `lead`, and later `resource-search`/`news`/`domain-update`) rather than a
  separate `leads` table or `/leads` route. This reuses the whole generic find pipeline.
- **The full implementation plan** (two layers, A = `type` discriminator, B = `prospector` agent) with exact
  files/lines, reuse points, tests, risks, and end-to-end verification — see the plan doc. Not started.

## Key decisions (and what was ruled out)

- **`type` discriminator on `finds`, NOT a separate `leads` table.** A lead is just another find type. Mirrors
  how `businesses.kind` is already a free-text discriminator with taxonomy applied at render time.
- **Column/param named `type`, not `kind`.** Chosen for URL↔column symmetry with `/feed?type=`. (`businesses`
  uses `kind`; the finds discriminator is deliberately `type`.)
- **Results go in the MAIN feed, filtered by `/feed?type=lead`. No `/leads` route** — user's call: "more types
  → more routes" scales badly; a query param scales. No default type exclusion; a card badge distinguishes leads.
- **Agent named `prospector`** — ruled out `salesman` (gendered), `salesgen`/`leadgen` (verb-y, and "sales"
  overstates a discovery-only agent), `salesperson` (implies outreach/closing). `prospector` fits the
  occupation-noun roster (scout/cartographer/curator) and the job: searches + qualifies, no outreach.
- **Discovery-only, local B2B.** Prospector qualifies the cartographer's OSM business directory (via the
  existing `list_businesses` MCP tool) against an Ideal Customer Profile (ICP) in its own `profile.md`. No
  pipeline/CRM state. Broad-market lead-gen explicitly out of scope (the local data foundation wouldn't serve it).
- **Extend `save_find` with an optional `type`, do NOT add a `save_lead` tool** — avoids duplicating
  `insertFind`'s dedupe/source-link/counter logic.
- **Curator becomes type-aware** (prompt-level): events expire by event date; leads never auto-expire (only
  hidden as same-business dupes or ICP misses). This is the one real behavioral change to an existing agent.

## Important context for future sessions

### Status — NOTHING implemented
- No schema/code/test changes made. `main` is clean. The only new files this session are the two docs
  (`docs/plans/...` and this handoff), both untracked/uncommitted.
- To execute, follow the plan doc top-to-bottom (Layer A migration first, then the prospector agent).

### Gotchas the plan already accounts for (don't rediscover)
- **ROSTER is duplicated in two places** that must stay in sync: `registry` + `rosterOrder` in
  `packages/agents/src/cli.ts`, and `ROSTER`/`RUN_TARGETS`/`resolveTarget` in `packages/db/src/runs.ts`
  (the web "Run" button validates against the latter). `packages/db/src/runs.test.ts` (~lines 39-42) hard-asserts
  the 4-agent roster — it will go red until updated to include `"prospector"`; that's the intended tripwire.
- **Migrations:** generate with `npx drizzle-kit generate`, apply with the custom runner
  `npx tsx packages/db/src/migrate.ts` (what `scripts/deploy/migrate.sh` runs). `drizzle-kit push` is dev/test-only.
  Adding `type text NOT NULL DEFAULT 'event'` self-backfills existing rows. Per the **2026-06-21 handoff**, any
  schema change also needs applying to the live/prod DB (`localfinds.peaslee.org`) or writes silently fail.
- **sync-merge (`packages/db/src/sync-merge.ts`) enumerates columns explicitly** — new `type` + `business_id`
  must be added, and `business_id` **remapped by `osm_id`** on merge (ids are per-DB; a naive copy points at the
  wrong prod business), same as the existing `source_id`-by-url remap.
- **`finds.score` exists in the schema but is never persisted by `insertFind`** — wire it through when adding
  `type`; the prospector reuses it as the lead fit score.
- Per the prior handoff: **`npm test` (vitest) does NOT typecheck** — run `tsc --noEmit` across all 3 packages
  when finishing the branch.

### Where the user defines "what they sell"
- The ICP lives in `data/agents/prospector/profile.md` (gitignored PII; only `profile.md.example` is committed,
  bootstrapped by `ensureWorkspace()` on first run). The prospector is useless until that profile is filled in.

### Data / branch
- Region = Knox County, Maine (`data/config/region.md`). Runtime data (DB `data/localfinds.db`, run logs) is
  gitignored. Agents run via `cd packages/agents && npx tsx src/cli.ts <name|all>`.
- Memory note `localfinds-architecture.md` still says "4-agent roster" — update it to five if/when prospector ships.
