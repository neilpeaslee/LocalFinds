import type { AgentDefinition } from "../run-agent";

export const scout: AgentDefinition = {
  name: "scout",
  // Real runs land at 37-39 turns (one was 39/40), so 40 left no headroom — a
  // slightly heavier run risks a maxTurns cutoff mid-work. Budget ($1/run) is
  // the intended guardrail and bites first; give turns room so it stays so.
  defaultMaxTurns: 45,
  // At the default (high) effort, reasoning dominated cost: run #26 spent ~$0.37
  // of its $0.75 Sonnet bill on output tokens and got cut off by the $1 budget
  // cap mid-run (only 8 finds vs run #25's 12). Scout's work is mostly triage —
  // search, judge snippets, save — not deep reasoning, so medium effort buys
  // more finds under the same cap. (Cartographer, pure ETL, went to "low".)
  // Drop to "low" if cost still bites; raise back to default if find quality drops.
  effort: "medium",
  allowedTools: [
    "WebSearch",
    "WebFetch",
    "Read",
    "Write",
    "Edit",
    "Glob",
    "Grep",
    "mcp__localfinds__save_find",
    "mcp__localfinds__list_recent_finds",
    "mcp__localfinds__read_feedback",
    "mcp__localfinds__list_sources",
    "mcp__localfinds__list_businesses",
  ],
  systemPrompt: `You are the scout for LocalFinds, a personal local-discoveries feed. You run unattended on a schedule; no one can answer questions mid-run.

Your job: find genuinely local, current items for the region in your task — events, organization/company announcements, government/official notices, openings and closings, and similar discoveries — and save the good ones with the save_find tool.

Honesty rules (non-negotiable):
- Never invent URLs, dates, or facts. Only save items you actually confirmed at a real page.
- Record dates exactly as published, in ISO 8601.
- If you find nothing genuine, save nothing — an empty run is a fine run.

Your working directory is your private workspace:
- profile.md is your interest profile. Keep it under ~150 lines; date your edits.
- notes/ is yours for scratch and coverage notes (e.g. notes/coverage.md).
Work only inside this workspace.`,
  buildTaskPrompt: ({ region, profile, categories }) => `## Region briefing (data/config/region.md)

${region}

## Your current interest profile (profile.md)

${profile}

## Business category priorities (data/config/categories.json)

${categories}

## This run

1. Call read_feedback. If there is new feedback, update the "Learned preferences" section of profile.md with dated bullets, each citing the feedback that drove it (e.g. "2026-06-12: user starred X / hid Y → ..."). Do this BEFORE searching.
2. Call list_recent_finds (last 7 days) so you don't re-save items already in the feed.
3. Read notes/coverage.md if it exists; diversify away from what recent runs already covered.
4. Run no more than 8 web searches (hard cap — stop searching once you reach 8) targeting the region: events, org/company announcements, official notices, openings/closings. Prefer pages from registered sources (list_sources) and primary sources over aggregators.
   - Fetch deliberately — WebFetch is by far the most expensive thing you do. Triage with the search-result snippets first and only fetch a page when (a) the snippet already looks like a genuine local, current item likely worth saving, and (b) you need the page to confirm it or to pin exact dates / the item's own URL. Skip dead-end or clearly off-region pages, and prefer a focused primary-source page over a large aggregator/roundup page. Aim for at most ~8 fetches per run. The honesty rule still stands — confirm every item you save at its real page; this just means don't spend fetches on pages you won't save.
   - You may also call list_businesses (with max_tier: 2 and exclude_chains: true) to use the cartographer's directory as monitoring targets: prefer businesses with a website, and check whether they have current news, events, sales, or an opening/closing worth a find.
5. For each genuine item, call save_find with: title, url, a 1-2 sentence summary written for the feed, event dates if any, published date if visible, and a few lowercase free-form tags. Quality over quantity — 5 to 15 good saves is a great run.
   - Dedupe is by URL: when one roundup page mentions several distinct items, give each item its own page URL if one exists; if a distinct item truly has no URL of its own, omit url (the title is then used for dedupe).
6. Finish by updating notes/coverage.md with a dated entry on what you covered and what to try next run.`,
};
