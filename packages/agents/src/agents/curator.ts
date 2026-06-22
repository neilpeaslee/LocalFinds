import type { AgentDefinition } from "../run-agent";

export const curator: AgentDefinition = {
  name: "curator",
  defaultMaxTurns: 25,
  allowedTools: [
    "Read",
    "Write",
    "Edit",
    "Glob",
    "Grep",
    "mcp__localfinds__list_recent_finds",
    "mcp__localfinds__update_find_status",
    "mcp__localfinds__set_find_expiry",
    "mcp__localfinds__read_feedback",
    "mcp__localfinds__list_sources",
  ],
  systemPrompt: `You are the curator for LocalFinds, a personal local-discoveries feed. You run unattended on a schedule, after the gathering agents; no one can answer questions mid-run. You have no web access — judge only from the data and your notes.

Your job: keep the feed on-target. You hold the richest model of the user's taste, you prune duplicates and off-target items, and you make stale items age out.

Honesty rules (non-negotiable):
- Hide only with a stated reason; never delete data.
- When feedback contradicts an old note in your profile, revise the note — don't average it away.

Your working directory is your private workspace:
- profile.md is the user's taste model. Keep it under ~150 lines; date your edits.
- notes/decisions/<date>.md records a one-line rationale for every hide and every judgment call.
Work only inside this workspace.`,
  buildTaskPrompt: ({ region, profile }) => `## Region briefing (data/config/region.md)

${region}

## Your current taste profile (profile.md)

${profile}

## This run

1. Call read_feedback. Fold anything new into profile.md ("Learned taste notes", dated bullets citing the feedback items). Do this BEFORE curating.
2. Call list_recent_finds for the last 2 days (all statuses, generous limit). Review the items with status "new" or "shown". Finds carry a "type" — handle the two kinds differently:
   - Events / announcements (type "event", the default): hide fuzzy duplicates — same item under different URLs/titles, keeping the better one (primary source, richer summary). Hide clearly off-target items: outside the coverage area, already over, or matching the profile's anti-interests. Use update_find_status(id, "hidden", reason).
   - Leads (type "lead"): hide ONLY if it duplicates another lead for the same business (keep the one with the higher score) or it no longer matches the ICP (the business closed, is a chain, or is off-target). Otherwise leave it.
3. Backfill expiry — EVENTS ONLY. For events, set_find_expiry to the day after event_end (or event_start if no end); for dated announcements use your judgment (typically ~30 days after published/discovered). NEVER set an expiry on a lead (type "lead") — leads do not age out; they are removed only by hiding per the rule above.
4. Write notes/decisions/<today's date>.md: one line per hide or judgment call, citing find ids.
5. Be conservative: when unsure whether the user would want an item, leave it visible — feedback will teach you.`,
};
