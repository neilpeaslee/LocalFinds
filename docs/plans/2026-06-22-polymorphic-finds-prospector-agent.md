# Polymorphic `finds` + `prospector` agent

_Status: **design plan, not yet implemented** (no code written as of 2026-06-22). Session handoff:
`docs/handoff/2026-06-22-001-polymorphic-finds-prospector-agent.md`._

## Context

**The question that started this:** would adding a lead-gen agent (a sibling to `scout`) disturb the
existing agents, and are they too coupled to `scout` for it to fit?

**Finding:** the agents are *not* tightly coupled to each other or to `scout`. They never call
each other — they communicate only through the shared SQLite store via one-directional reads
(cartographer→businesses→scout/source-keeper; scout/source-keeper→finds→curator). The only place
shared infra hard-codes `"scout"` is a fetch-logging/host-block carve-out in `run-agent.ts` the new
agent wouldn't use. A 5th agent slots in mechanically for free (free-text `agent`/`added_by`
columns, generic run/feedback/transcript machinery, the `/agents` page iterates `ROSTER`).

**The real coupling is system-to-*domain*:** everything downstream (`finds` table → curator → feed
user interface (UI) → feedback) is shaped around "local current events for a personal feed." A lead
is not an event. The user's chosen direction resolves this cleanly: **a lead is a *type* of find.** A
find gets a `type` discriminator (`event`, `lead`, and later `resource-search`, `news`,
`domain-update`). This reuses the entire generic find machinery instead of building a parallel store,
and types are distinguished/filtered in the **main feed** via a query param (`/feed?type=lead`) — no
per-type routes, which scale poorly as more types are added.

**Scope of this plan:** (A) make `finds` polymorphic by `type`; (B) add a discovery-only `prospector`
agent doing **local business-to-business (B2B) lead-gen** off the cartographer's business directory.
The name fits the roster's occupation-noun pattern (scout / cartographer / curator) and the job: a
prospector searches and qualifies, it does not do outreach or close. Other future types are out of
scope but become near-free once `type` exists.

> Naming note: the discriminator column is `type` (matching the `/feed?type=` parameter). It is
> free-text, mirroring the discriminator pattern already used by `businesses.kind` (a free-text tag
> with taxonomy applied at render time, not a hard enum) — we just use the name `type` here for
> URL/column symmetry.

## Layer A — `type` discriminator on `finds`

**A1 — Schema + migration.** In `packages/db/src/schema.ts`, add to the `finds` table (after
`score`, line 51):
```ts
type: text("type").notNull().default("event"),       // free-text discriminator (cf. businesses.kind, line 75)
businessId: integer("business_id").references(() => businesses.id),  // nullable foreign key (FK); links a lead to its OpenStreetMap (OSM) record
```
`NOT NULL DEFAULT 'event'` *is* the backfill — every existing row (all scout/source-keeper finds)
becomes `event`. `businessId` is a forward reference resolved by the `.references(() => ...)` thunk
(`businesses` is declared after `finds`); confirm with a type build.
Generate + apply via this repo's path (run from `packages/db`):
`npx drizzle-kit generate` → `npx tsx src/migrate.ts` (the custom runner `packages/db/src/migrate.ts`,
same as `scripts/deploy/migrate.sh`; **not** `drizzle-kit push`, which is dev/test-only). Commit the
new `drizzle/0001_*.sql` + `drizzle/meta/`.

**A2 — Write path: extend `save_find`, do NOT add `save_lead`.** A second tool would duplicate
`insertFind`'s dedupe / source-link / counter logic. `type` is just another column.
- `packages/agents/src/mcp-tools.ts` (`save_find`, lines 145-190): add optional Zod params `type`
  (default `"event"`), `business_id`, `score`; thread them into the `insertFind({...})` call.
- `packages/db/src/queries.ts` (`insertFind`, lines 60-113): extend `NewFindInput` and the
  `.values({...})` block with `type: input.type ?? "event"`, `businessId`, and `score` (note: `score`
  is currently in the schema but *never persisted* by `insertFind` — add it now). Dedupe stays by
  `urlHash`, unchanged.

**A3 — Feed reads.** `packages/db/src/queries.ts`: add `type?: string` (and `excludeTypes?: string[]`)
to `FeedFilters` (line 118) and push conditions in `feedConditions` (line 150) modeled exactly on the
existing `tag` block (lines 171-174), using the already-imported `inArray`/`notInArray`. Add a
`listFindTypes()` facet helper beside `listActiveTags`. **No default type exclusion** — per the
"results in the main feed" decision, events and leads share one feed; the `type` param narrows it and
a card badge distinguishes leads. (A persisted "hide leads by default" cookie is a
you-aren't-gonna-need-it (YAGNI) follow-up, not part of this plan.)

**A4 — Cards + filter UI (main feed only, no new route).** `find.type`/`find.score` flow onto the
`Find` type automatically.
- `apps/web/src/components/FindCard.tsx` + `CompactFindCard.tsx`: render a type badge only when
  `type !== "event"` (events stay visually identical); for leads, optionally show fit score + a link
  to the linked business.
- Wire an optional `type` filter through `feed-url.ts` (`FeedState.type` + `feedHref`), `settings.ts`
  (read ad-hoc in `resolveFeed`, **not persisted**, same as `tag`), `feed/page.tsx` (pass `type` to
  `getFeedPage`; feed `listFindTypes()` to the bar), and `FilterBar.tsx` (a type chip row mirroring
  the tag row). The result: `/feed` shows everything, `/feed?type=lead` shows only leads — **no
  dedicated `/leads` route**.

**A5 — sync-merge.** `packages/db/src/sync-merge.ts` enumerates `finds` columns explicitly. Add
`type` and `business_id` to the INSERT column list, SELECT, and ON CONFLICT SET. **Critically, remap
`business_id` by `osm_id`** (ids are per-database; a naive copy points at the wrong prod business)
using the same subquery idiom the file already uses to remap `source_id` by url; fall back to NULL if
unmatched.

## Layer B — `prospector` agent (discovery-only, local B2B)

**B1 — `packages/agents/src/agents/prospector.ts`** (new), mirroring `scout.ts`:
`name:"prospector"`, `effort:"medium"`, `defaultMaxTurns:30`, default model.
- `allowedTools`: workspace file tools + `list_businesses` (the prospect universe — already exposed
  as a Model Context Protocol (MCP) tool, already consumed by scout/source-keeper), `list_recent_finds`,
  `read_feedback`, `save_find`, and `WebSearch`/`WebFetch` for verify-only enrichment.
- `buildTaskPrompt({region, profile, categories})`: `read_feedback` → fold into the ideal-customer
  profile (ICP); `list_recent_finds` + `notes/coverage.md` to avoid re-saving; walk `list_businesses`
  (`max_tier`/`exclude_chains`/`has_website`) as a resumable town cursor (cartographer pattern); for
  each ICP match optionally verify on the web, then `save_find` with `type:"lead"`,
  `business_id`=row id, `url`=business website/OSM URL (distinct from event URLs so `url_hash` won't
  collide), `score`=fit. Qualification *reasoning* goes into `notes/` markdown, **not** the database
  (DB) — storage-split: exact facts in SQLite, fuzzy judgment in markdown.

**B2 — `data/agents/prospector/profile.md.example`** (new — the only committed profile; real
`profile.md` is gitignored personally identifiable information (PII), bootstrapped by
`ensureWorkspace()` on first run). Sections mirroring `scout/profile.md.example`: ICP / Disqualifiers
/ Fit scoring / Learned signals (empty, feedback-fed) / Standing instructions. **This file is where
the user defines what they sell and to whom.**

**B3 — Dual roster registration (the duplication gotcha — both or the Run button rejects it):**
- `packages/agents/src/cli.ts`: add `prospector` to `registry` and `rosterOrder`.
- `packages/db/src/runs.ts`: add `"prospector"` to `ROSTER` (`RUN_TARGETS`/`resolveTarget`/`AgentName`
  all derive from it).
- **Run-order slot:** `scout → source-keeper → cartographer → prospector → curator` — after
  cartographer (so it reads fresh `businesses`), before curator (so curator prunes leads same cycle).

**B4 — Curator becomes type-aware** (`packages/agents/src/agents/curator.ts`, `buildTaskPrompt`):
split prune/expiry by type. **Events:** unchanged (hide dupes/off-target, `set_find_expiry` by event
date). **Leads:** never set an expiry; only hide if it's a duplicate for the same business (keep the
higher score) or no longer matches the ICP (closed / chain / off-target). One explicit prompt line
stating the distinction. (Prompt-level, not code-enforced — the one real behavioral coupling to fix.)

## Reuse (don't rebuild)
- `insertFind` (queries.ts:60) — the single write path; extend, don't duplicate.
- `list_businesses` / `listBusinessesRanked` — the prospector's prospect pool, already built.
- `feedConditions` tag-filter pattern (queries.ts:171) — template for the `type` filter.
- `businesses.kind` free-text + render-time taxonomy — the precedent for `finds.type`.
- `score` column (already in schema) — the lead fit score.
- `ensureWorkspace()` profile bootstrap — gives the prospector its ICP profile for free.

## Tests
- `packages/db/src/queries.test.ts`: `insertFind` type round-trip (+ default `"event"` when omitted),
  feed `type`/`excludeTypes` filter, `listFindTypes`.
- `packages/db/src/sync-merge.test.ts`: lead with `business_id` merges with the prod business id
  *remapped* by `osm_id`; a NULL-business lead survives.
- `packages/db/src/runs.test.ts` (≈ lines 39-42): **update the roster assertion to include
  `"prospector"`** — this test is the ROSTER-duplication tripwire and will (correctly) go red until updated.
- `apps/web/src/lib/feed-url.test.ts` / `settings.test.ts`: `type` round-trips ad-hoc (not persisted).

## Docs / memory
- `README.md`: Architecture ("four agents" → five + a prospector line) and the run-agents example.
- Flag (do not auto-edit) the user memory `localfinds-architecture.md` ("4-agent roster") for update.

## Risks / gotchas
- **Curator coupling (B4)** is the only real behavioral change to the existing roster; it's
  prompt-level, so verify by running curator against a DB containing leads.
- **ROSTER duplication (B3)** — easy to register in one place and not the other.
- **sync-merge `business_id` remap (A5)** — a naive id copy silently corrupts prod links.
- **Region scoping** — this design assumes leads are *local* businesses (Knox County). Broad-market
  lead-gen would not fit the foundation; confirmed in scope is local B2B only.

## Verification (end-to-end)
1. `cd packages/db && npx drizzle-kit generate && npx tsx src/migrate.ts`; open `db:studio` and
   confirm existing `finds` rows show `type='event'` and the new `business_id` column exists.
2. Root `npm test` — all suites green (including the updated `runs.test.ts`).
3. After a cartographer run, `npm run agent -- prospector --max-turns 8`; watch the transcript for
   `→ mcp__localfinds__save_find {"type":"lead", "business_id":..., "score":...}`.
4. `npm run dev` → `/feed` shows leads + events together; `/feed?type=lead` shows only lead cards
   rendered `via prospector`; switching the type chip to Events makes leads disappear (proves the
   single-feed + `type` filter works without a separate route).
5. `npm run agent -- curator --max-turns 8`; confirm it never sets an expiry on a lead.

## Out of scope (where future types plug in)
`resource-search`, `news`, `domain-update` need **no further code** — each is just a new string value
in `finds.type`, surfaced automatically by the type facet, produced by a future agent. Don't
enumerate them anywhere.
