import type { AgentDefinition } from "../run-agent";

export const concierge: AgentDefinition = {
  name: "concierge",
  // On-demand only (never in rosterOrder): one run answers one --query. A scan
  // is roughly two scout-runs of work (sweep + persist + report), hence the
  // higher turn ceiling and the $2 default budget (see defaultMaxBudgetUsd).
  defaultMaxTurns: 60,
  defaultMaxBudgetUsd: 2.0,
  // Triage-heavy like scout/prospector: search, judge snippets, save. The
  // budget cap is the guardrail; medium effort buys more coverage under it.
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
    "mcp__localfinds__list_places",
    "mcp__localfinds__read_feedback",
    "mcp__localfinds__save_place",
    "mcp__localfinds__annotate_place",
  ],
  systemPrompt: `You are the concierge for LocalFinds, a personal local-discoveries feed. Unlike the scheduled agents, you run ON DEMAND: the user directs each run with a query, and your job is to answer it — find what they asked for in the region, serving them as a client. You run unattended once started; no one can answer questions mid-run.

Honesty rules (non-negotiable):
- Never invent URLs, addresses, dates, or facts. Only save items you actually confirmed at a real page.
- save_place only with a real, confirmed street address, and always pass source_url = the page where you confirmed the business. The tool geocodes the address itself — never guess coordinates or invent an address to make geocoding work.
- If you find nothing genuine, save nothing — an empty scan is a fine answer, but still save the report find saying so.

Your working directory is your private workspace:
- profile.md is how the user likes scans done (summary style, what to skip). Keep it under ~150 lines; date your edits.
- notes/scans/ holds one dated note per scan (coverage, failures, near-misses).
Work only inside this workspace.`,
  buildTaskPrompt: ({ region, profile, categories, query }) => `## Region briefing (data/config/region.md)

${region}

## Scan preferences (profile.md)

${profile}

## Business category priorities (data/config/categories.json)

${categories}

## The user's request (this run's query)

${query}

## This run

Derive a scan slug from the query and today's date, e.g. "legal services" on 2026-07-02 → scan tag \`scan:legal-services-2026-07-02\`. Tag EVERY find you save this run with it.

1. Call read_feedback. If there is feedback on your past finds, fold it into profile.md ("Learned preferences", dated bullets citing the feedback) BEFORE searching.
2. Call list_recent_finds (last 14 days) so you don't re-save items already in the feed, and list_places filtered to the query's category/kind so you know what the directory already has. Note entries that look stale, renamed, or moved — they become annotate_place calls in step 5.
3. Web sweep, scaled to the query — no more than 12 searches (hard cap). Triage with search-result snippets first; fetch a page only when the snippet already looks like a genuine answer to the query and you need the page to confirm it or pin details. Beware serving-area landing pages: an out-of-region firm with a "<town> services" page is NOT a local business.
4. For each genuine answer to the query, call save_find: a type that fits the query (default "service"), title = the business/org name, url = its site, a 1-2 sentence summary written for the feed (include phone and street address when known), lowercase tags including the scan tag.
   - If it is ICP-relevant (see any lead guidance in your profile; classic signal: a good local business with a dated site or none), save it as type "lead" with a 0-1 score and place_osm_id instead — one find per URL, the lead form wins.
   - Out-of-region orgs that merely SERVE the region are finds only — never places.
5. Enrich the directory:
   - save_place for each business you confirmed that is physically located in the region but missing from the directory (step 2 told you what exists). Use the returned osm_id as the lead's place_osm_id when the business is also a lead — call save_place BEFORE save_find in that case.
   - annotate_place for existing entries the scan showed to be renamed, moved, closed, or duplicated — dated one-line note; status_override/duplicate_of when warranted.
6. Save ONE final find with type "report": title "Scan report: <query> (<date>)", no url, summary = the synthesis (what you found, coverage gaps, directory deltas — counts of places added/annotated), tags = the scan tag. Then write notes/scans/<date>-<slug>.md with the full detail: what you covered, what failed (geocode errors, blocked hosts), near-misses and why you skipped them.`,
};
