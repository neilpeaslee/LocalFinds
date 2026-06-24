// The interviewer's static configuration: model, effort, tool allow/deny lists,
// the per-path system prompts, and the prepared-mode questionnaire template.
//
// Unlike the scheduled agents, the interviewer does NOT go through runAgent /
// AgentDefinition — it has no DB workspace, no localfinds MCP server, and no
// buildTaskPrompt. It writes config exclusively through its own interviewer MCP
// tools. interview.ts is its dedicated runner; it is intentionally absent from
// cli.ts's roster so the scheduler never runs it.

import type { ReasoningEffort } from "../run-agent";

export const INTERVIEWER_MODEL = "claude-sonnet-4-6";
// Issue 5: medium gives snappy interactive turns at lower cost; every tuned
// agent dials effort down, none use high. A higher tier is only worth it for the
// non-interactive prepared generation if quality ever demands it.
export const INTERVIEWER_EFFORT: ReasoningEffort = "medium";

// The interviewer's MCP tools. ask_user is interactive-only and dropped for the
// prepared path (see PREPARED_TOOLS).
export const INTERVIEWER_TOOLS = [
  "mcp__interviewer__ask_user",
  "mcp__interviewer__say",
  "mcp__interviewer__read_current_config",
  "mcp__interviewer__geocode_town",
  "mcp__interviewer__set_region",
  "mcp__interviewer__set_towns",
  "mcp__interviewer__set_categories",
  "mcp__interviewer__write_icp",
];

// Prepared mode answers from a file — never asks live, so ask_user is removed.
export const PREPARED_TOOLS = INTERVIEWER_TOOLS.filter(
  (t) => t !== "mcp__interviewer__ask_user",
);

// Hard lockout for both paths: the interviewer writes config ONLY through its MCP
// tools, never the filesystem or web directly, and must not spawn sub-agents.
export const INTERVIEWER_DISALLOWED = [
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
  "Bash",
  "Agent",
  "Task",
  "AskUserQuestion",
];

const SHARED_RULES = `You are the LocalFinds interviewer. Your one job is to set up targeting for a hyper-local discovery system: a region, a town list, business-category search tiers, and the prospector's Ideal Customer Profile (ICP). You write all of these through your tools — you never touch files or the web directly.

How the system uses what you write:
- The region (set_region) names the area and its state; the state is reused to geocode towns.
- The town list (set_towns) drives the map and the prospector's town filters. You supply each town's NAME and COUNTY (for disambiguation) — NEVER coordinates; the tool geocodes new towns and KEEPS the hand-tuned bbox of any town that already exists.
- The category tiers (set_categories) are OSM "key=value" kinds ranked 1 (highest priority) to 4 (excluded from the directory). "key=*" matches any value of a key.
- The ICP (write_icp) is prose the prospector reads before every run to qualify businesses as leads.

Process (always):
1. Call read_current_config FIRST. Edit what's there; do not blindly overwrite. Nulls mean "not set yet".
2. Gather the answers you need (see your mode below).
3. Write the STRUCTURED config first, in order: set_region, then set_towns, then set_categories. Then write_icp LAST, referencing the same towns and categories so the prose and the structured config agree.
4. For towns, pass county for every town (e.g. "Knox County"); set primary:true on exactly one home town. If set_towns reports a town with an error, re-resolve it (try a query override) or drop it — never invent coordinates.

ICP rules:
- Keep it under ~150 lines. Use these sections: What you offer; Ideal customer (who's a lead); Disqualifiers; Fit scoring (0-1); Learned signals; Standing instructions.
- Be specific and grounded in the user's answers. Discovery only — the prospector never contacts businesses.

The runner shows the user a real before/after diff of every file you changed and asks them to confirm at the end — so make your writes count, but don't ask the user to confirm saves yourself.`;

export const INTERACTIVE_SYSTEM_PROMPT = `${SHARED_RULES}

## Your mode: live interview
Talk with the user through ask_user, one question at a time. Start broad (what they sell, who their ideal customer is), then ask adaptive follow-ups to sharpen the ICP and the town/category targeting. Use say to share brief context or confirm understanding. Take the time to get it right — there is no timer. When you have enough, write the config and ICP as described.`;

export const PREPARED_SYSTEM_PROMPT = `${SHARED_RULES}

## Your mode: prepared questionnaire
The user has already answered a fixed questionnaire (included in your first message). You cannot ask follow-ups — work from their answers, making sensible best-guess interpretations where they're ambiguous, and note any assumptions in the ICP's Standing instructions. Write the config and ICP in one pass.`;

// The prepared-path questionnaire. The user fills every "Answer:" line and re-runs.
// isQuestionnaireFilled (interview.ts) treats any non-empty Answer: line as filled.
export const QUESTIONNAIRE_TEMPLATE = `# LocalFinds interview — prepared questionnaire

Fill in each "Answer:" line below, then re-run \`npm run interview -- --prepared\`.
Write as much detail as you like after each "Answer:"; the interviewer turns these
into your region, town list, category tiers, and prospector ICP.

## 1. What do you offer?
What product or service would you pitch to local businesses?
Answer:

## 2. Who is your ideal customer?
What kinds of local businesses are a good fit (type, size, what they're missing)?
Answer:

## 3. Who is NOT a customer (disqualifiers)?
Categories, chains, or situations that never convert.
Answer:

## 4. Which towns do you cover?
List each town with its county, e.g. "Rockland (Knox County), Camden (Knox County)".
Mark your home/primary town.
Answer:

## 5. Region coverage notes
Describe the overall area and any scope notes (islands, neighboring towns, etc.).
Answer:

## 6. Anything else the prospector should know?
Standing preferences, signals you care about, etc. (optional)
Answer:
`;

// The interactive kickoff message. A resume seed (prior un-written answers) is
// appended when re-entering an interrupted session.
export function interactiveKickoff(resumeSeed?: string): string {
  const base =
    "Begin the interview. Call read_current_config first, then start asking the user about their business and targeting.";
  return resumeSeed ? `${base}\n\n${resumeSeed}` : base;
}

// The prepared kickoff message: the user's filled questionnaire answers.
export function preparedKickoff(answers: string): string {
  return `The user filled in this questionnaire. Read it, call read_current_config, then write the region, towns, categories, and ICP.\n\n----- QUESTIONNAIRE -----\n${answers}\n----- END -----`;
}
