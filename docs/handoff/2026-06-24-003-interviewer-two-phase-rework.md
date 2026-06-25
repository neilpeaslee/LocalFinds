# Handoff — Interviewer review + two-phase rework

_Date: 2026-06-24 · Branch: `feat/interviewer-agent` · Session topic: review the live interview
(it got ~80% of the ICP, felt rushed/rigid), compare it to the follow-up chat, then implement fixes
#1–#5._

## What was accomplished

Reviewed the interviewer against evidence, then shipped five fixes in commit **`a5009d2`**
(`refactor(interviewer): two-phase flow, kept transcripts, run-grounded context` — 6 files,
+367/−82). The review itself:

- **The interview's own transcript was gone** — `clearJournal()` deleted `session.jsonl` on a
  confirmed save, and it's gitignored. The runner erased the one artifact you'd want to review.
- **Reconstructed the timeline from Claude Code transcripts** (`~/.claude/projects/-home-neil-Projects-LocalFinds/*.jsonl`):
  `a56d752b` (15:31–16:13) built the agent; a ~40-min terminal `npm run interview` ran in the gap
  (16:13–16:54, no CC log); **`0dc5a5f6` (16:54–22:27) is "the chat"** that refined the profile.
- **The 20% the interview missed** (visible in `0dc5a5f6`): the ICP *over-promised on ops/automation*
  the user can't deliver well (chat turn 07); the **engagement trajectory** web/AI → BI → ops as a
  *spine* (turn 10, "the most important input yet"); four-factor scoring vs industry tiers; the
  untested "hospitality one band lower" assumption (turn 12).

The five fixes (recs #1–#5; #6 "refine loop" deferred):

1. **#5 — keep transcripts.** `clearJournal()` → **`archiveJournal(name)`** in
   `interview-journal.ts`: on a confirmed save it *moves* `session.jsonl` to
   `data/agents/interviewer/runs/<ts>.jsonl` (the same `runs/` convention every scheduled agent uses;
   moving also clears the live journal so the next interview starts fresh). Runner prints
   `Transcript kept at …`. `clearJournal` retired.
2. **#1 — kill the invisible clocks.** `interview.ts`: dropped the "Grab a coffee… 5–10 minutes"
   banner; **`maxTurns` 60 → 200** (every `ask_user` blocks on a human, so it can't run away — the cap
   only backstops a non-interactive tool loop). These two were the "time crunch you could feel but not
   see."
3. **#4 — split collection from synthesis** (per Neil's call) + **immediate ack.** The interactive
   path is now **two `query()` phases**: collection (effort `medium`, snappy, writes nothing) then
   synthesis (effort `high`, writes config from the rendered transcript). Plus an instant
   `· got it — thinking…` printed the moment the user hits enter (`io.ask`), fixing the dead-air-after-enter
   complaint. Synthesis **shares its prompt/tools/effort with the prepared path**.
4. **#2 — conversation, not a form.** New `COLLECTION_SYSTEM_PROMPT`: clustered questions (not
   one-at-a-time), reflect-back via `say`, explicit challenge of the *offer-vs-deliver* gap (the
   turn-07 catch), and probes skill-ranking / trajectory / fit-scoring before anything is written.
5. **#3 — give it eyes.** New `packages/agents/src/prospector-context.ts`: `recentProspectorContext()`
   injects a compact recent-runs + leads summary into the collection kickoff. (Discovery:
   `read_current_config` *already* feeds it region/towns/categories/current ICP — the only real gap vs
   the chat was prospector **run results**.)

**Verification:** `cd packages/agents && npx vitest run` → **87/87 pass**; `npx tsc --noEmit` clean.
New TDD'd pure functions: `renderTranscript` (`interview-journal.ts`, phase-1→2 handoff) and
`formatProspectorActivity` (`prospector-context.ts`). Smoke-checked `recentProspectorContext()`
against the live DB (real block: runs #36–38, 5 leads) and the `--prepared` early path (exit 0).

## Key decisions

- **Two phases, not one higher-effort pass.** Raising effort globally would have made the
  dead-air-after-enter *worse* (slower per-turn thinking). Splitting keeps each conversational turn
  snappy (medium) and confines the one slow step (high-effort synthesis) to the end, where a
  "writing it up…" wait reads as progress, not stall. Neil chose this explicitly.
- **Synthesis is unified with prepared mode.** Phase-2 synthesis turned out to be exactly what
  `--prepared` already does (write config from text, no `ask_user`), so they now share
  `SYNTHESIS_SYSTEM_PROMPT` / `SYNTHESIS_TOOLS` / `INTERVIEWER_SYNTHESIS_EFFORT`. `SHARED_RULES` was
  split into `SYSTEM_CONTEXT` (both phases) + `WRITING_PROCESS` (synthesis only) so collection carries
  no writing instructions.
- **#3 scoped to run results, not "read everything."** `read_current_config` already covers config;
  the web stays deliberately out of the interviewer's reach (`INTERVIEWER_DISALLOWED` unchanged).
  Run-grounded *refinement* is really the job of the deferred **#6 refine loop** — `#3` is a
  lightweight down-payment that no-ops on a true cold start (empty string when there are no runs).
- **Failed/partial synthesis rolls back.** On a non-success phase-2, the runner `restore()`s the
  pre-run snapshot so no unconfirmed writes persist; the journal is kept so a re-run resumes.
- **Renamed constants** (only `interview.ts` imported them): `INTERACTIVE_SYSTEM_PROMPT`→
  `COLLECTION_SYSTEM_PROMPT`, `PREPARED_SYSTEM_PROMPT`→`SYNTHESIS_SYSTEM_PROMPT`, `INTERVIEWER_TOOLS`/
  `PREPARED_TOOLS`→`COLLECTION_TOOLS`/`SYNTHESIS_TOOLS`, `INTERVIEWER_EFFORT`→
  `INTERVIEWER_COLLECTION_EFFORT`+`INTERVIEWER_SYNTHESIS_EFFORT`, `interactiveKickoff`/`preparedKickoff`→
  `collectionKickoff`/`synthesisKickoff`.

## Important context for future sessions

- **Branch status:** committed on `feat/interviewer-agent` as `a5009d2`, **not pushed**. Working tree
  still has pre-existing, unrelated `M README.md` and untracked
  `docs/handoff/2026-06-23-001-localfinds-us-domain-parking.md` — intentionally left out of the commit.
- **The one unverified thing: the live two-phase run.** Unit tests + tsc + smoke checks pass, but a
  real `npm run interview` (human + `ANTHROPIC_API_KEY`, real spend) has NOT been run on the new
  design. On that run, watch two things: (a) **collection actually ENDs** (gives a closing `say` and
  stops asking — it lacks setter tools, so it can't write; if it loops, tighten the "END" instruction
  in `COLLECTION_SYSTEM_PROMPT`), and (b) **synthesis writes all four configs** from the transcript.
- **Data locations:** archived transcripts → `data/agents/interviewer/runs/<ts>.jsonl`; ICP →
  `data/agents/prospector/profile.md`; structured config → `data/config/{region.md,towns.json,categories.json}`.
  All under gitignored `data/`. `scripts/deploy/sync-content.sh` rsyncs `data/` to prod, so a local
  interview ships its config/ICP on the next deploy.
- **#6 (refine loop) is the remaining rec** and the proper long-term home for run-grounded refinement
  (periodic session showing recent leads + thumbs/stars → ICP tweaks). See
  `docs/plans/2026-06-24-interviewer-agent.md` (out-of-scope section) for the original sketch.
- **Memory updated:** `interviewer-agent.md` + `MEMORY.md` index now describe the two-phase design and
  flag the live run as unexercised.
- **No pre-existing test failures** in `packages/agents` (all 87 green). The slow one is
  `mcp-tools.test.ts` (~7s), unrelated.
