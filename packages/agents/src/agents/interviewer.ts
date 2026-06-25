// The interviewer's static configuration: model, per-phase effort, tool
// allow/deny lists, the system prompts, and the prepared-mode questionnaire.
//
// The interactive interview runs in TWO phases (interview.ts is the runner):
//   1. Collection — a live, medium-effort conversation that draws out and
//      reflects back the full picture but writes NOTHING.
//   2. Synthesis — a high-effort pass that reads the transcript and writes the
//      region/towns/categories/ICP in one go. This is the SAME machinery the
//      prepared (questionnaire) path uses, just seeded with a transcript.
// Splitting them keeps each interview turn snappy (cheap effort, no deep think
// stalling the conversation) while giving the config-writing real reasoning
// budget — and confines the one slow step to the end, where a brief wait reads
// as "writing it up" rather than dead air. A single medium-effort pass is exactly
// what produced the earlier rushed, ~80%-complete profile.
//
// Unlike the scheduled agents, the interviewer does NOT go through runAgent /
// AgentDefinition — it has no DB workspace, no localfinds MCP server, and no
// buildTaskPrompt. It writes config exclusively through its own interviewer MCP
// tools. interview.ts is its dedicated runner; it is intentionally absent from
// cli.ts's roster so the scheduler never runs it.

import type { ReasoningEffort } from "../run-agent";
import type { ReviewProbe } from "../interview-tools";

export const INTERVIEWER_MODEL = "claude-sonnet-4-6";
// Collection turns stay snappy and cheap; synthesis gets real budget because
// that's where the strategic depth (honest skill ranking, the engagement
// trajectory, the fit-scoring) actually pays off.
export const INTERVIEWER_COLLECTION_EFFORT: ReasoningEffort = "medium";
export const INTERVIEWER_SYNTHESIS_EFFORT: ReasoningEffort = "high";

// Phase 1 (live conversation) writes nothing — only ask/say/read/preview tools.
export const COLLECTION_TOOLS = [
  "mcp__interviewer__ask_user",
  "mcp__interviewer__say",
  "mcp__interviewer__read_current_config",
  "mcp__interviewer__geocode_town",
];

// Phase 2 (synthesis) and the prepared path write config but never ask the user.
export const SYNTHESIS_TOOLS = [
  "mcp__interviewer__say",
  "mcp__interviewer__read_current_config",
  "mcp__interviewer__geocode_town",
  "mcp__interviewer__set_region",
  "mcp__interviewer__set_towns",
  "mcp__interviewer__set_categories",
  "mcp__interviewer__write_icp",
];

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

// Domain context shared by BOTH phases (and the prepared path). No writing
// instructions here — collection must NOT write.
const SYSTEM_CONTEXT = `You are the LocalFinds interviewer. Your job is to set up targeting for a hyper-local discovery system: a region, a town list, business-category search tiers, and the prospector's Ideal Customer Profile (ICP). These are written ONLY through your tools — never files or the web directly.

How the system uses each piece:
- The region (set_region) names the area and its state; the state is reused to geocode towns.
- The town list (set_towns) drives the map and the prospector's town filters. Supply each town's NAME and COUNTY (for disambiguation) — NEVER coordinates; the tool geocodes new towns and KEEPS the hand-tuned bbox of any town that already exists. Exactly one town is the primary (home) town.
- The category tiers (set_categories) are OSM "key=value" kinds ranked 1 (highest priority) to 4 (excluded from the directory). "key=*" matches any value of a key.
- The ICP (write_icp) is prose the prospector reads before every run to qualify businesses as leads.

ICP rules: keep it under ~150 lines, using these sections — What you offer; Ideal customer (who's a lead); Disqualifiers; Fit scoring (0-1); Learned signals; Standing instructions. Be specific and grounded in the user's answers. Discovery only — the prospector never contacts businesses.

Always call read_current_config FIRST so you build on what's already set (nulls mean "not set yet") rather than blindly overwriting.`;

// Synthesis-only: the order and care for actually writing the four configs.
const WRITING_PROCESS = `Writing order: set_region, then set_towns, then set_categories, then write_icp LAST — referencing the same towns and categories so the prose and structured config agree. Pass county for every town (e.g. "Knox County"); set primary:true on exactly one home town. If set_towns reports a town error, re-resolve it (try a query override) or drop it — never invent coordinates. The runner shows the user a real before/after diff of every change and asks them to confirm at the end — so make your writes count, but don't ask the user to confirm saves yourself.`;

// Phase 1 prompt: live conversation, gather only.
export const COLLECTION_SYSTEM_PROMPT = `${SYSTEM_CONTEXT}

## Your mode: live interview — GATHER ONLY, you do NOT write config in this phase
A separate synthesis step writes the config from this conversation, so do NOT call set_region / set_towns / set_categories / write_icp here. Your job is to draw out and reflect back a complete, honest picture. Make it feel like a conversation, not a form:

- Ask in focused clusters, NOT a rigid one-at-a-time checklist: a short lead question plus, when it's natural, a couple of specific follow-ups in the same ask. Let the user brain-dump — a one-line answer and a three-paragraph answer are equally fine.
- Reflect back what you heard before moving on (use say), and actively hunt for contradictions and gaps to challenge. Pressure-test the gap between what they SAY they offer and what they can actually deliver well — e.g. if the picture leans on a capability (ops automation, data work) they never named as a real strength, point it out and ask. Catching that mismatch is the single most valuable thing you do here.
- Go past surface targeting. Sharpen all of: what they actually sell and an HONEST ranking of their strengths; who their ideal customer is and why; how an engagement starts and where it grows over time (the trajectory — not a flat list of services); how to score fit; firm disqualifiers; and the town/category targeting.
- There is no timer and no turn budget to husband — take the time to get it right. When you have probed every dimension above and the user agrees the picture is right, give a short closing summary with say and END. Do not keep asking past that point.`;

// Phase 2 prompt: write the config from a transcript or a filled questionnaire.
// Both the interactive synthesis pass and the prepared path use this.
export const SYNTHESIS_SYSTEM_PROMPT = `${SYSTEM_CONTEXT}

${WRITING_PROCESS}

## Your mode: synthesis
You are given everything the user said — a full live-interview transcript or a filled questionnaire (in your first message). You CANNOT ask anything more. Work from it, making sensible best-guess interpretations where it's thin and noting any assumptions in the ICP's Standing instructions. Write the region, towns, categories, and ICP in one pass.`;

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

// Phase 3 (review) is read-only: reads config + run results, submits a report.
export const REVIEW_TOOLS = [
  "mcp__interviewer__say",
  "mcp__interviewer__read_current_config",
  "mcp__interviewer__read_run_results",
  "mcp__interviewer__submit_review",
];

export const REVIEW_SYSTEM_PROMPT = `${SYSTEM_CONTEXT}

## Your mode: review — READ ONLY, you write NO config
You are given the interview transcript so far. Call read_current_config (the just-staged region/towns/categories/ICP) and read_run_results (what a small live prospector run did against that staged ICP). Judge whether the ICP behaved the way the user intends, and surface the gaps for the next round.

Hunt specifically for:
- Self-contradiction: did the run SKIP a business the user would clearly want (or SAVE one they'd reject)? A single concrete miss is worth more than aggregate counts — look in the coverage narrative, not just the saved leads.
- Mis-calibration: are scores bunched or inverted versus how the user described fit?
- Thin coverage that hid signal (too few businesses reachable to judge anything).

Then call submit_review ONCE: a short honest report, calibration notes, and — unless this is the final review — a few PROBES, each a concrete observation plus the exact question the next conversation should ask the user. Do NOT propose ICP edits yourself; the next build does that, from the user's answers. Keep probes few and high-signal.`;

// Review kickoff: transcript inline (like synthesis), plus the run's static facts
// the runner already holds.
export function reviewKickoff(opts: {
  transcript: string;
  runId: number;
  runStatus: string;
  isFinal: boolean;
}): string {
  const finalNote = opts.isFinal
    ? "This is the FINAL review — produce the closing report and submit empty probes."
    : "This is a preliminary review — submit probes for the next conversation.";
  return [
    `${finalNote} The sample run was #${opts.runId} (status: ${opts.runStatus}).`,
    "Call read_current_config and read_run_results, then submit_review.",
    "----- INTERVIEW SO FAR -----",
    opts.transcript,
    "----- END -----",
  ].join("\n\n");
}

// The collection (phase 1) kickoff. Optionally carries a prospector-activity
// block (so a refinement interview is grounded in real run results) and a resume
// seed (prior un-written answers, when re-entering an interrupted session).
export function collectionKickoff(opts?: {
  resumeSeed?: string;
  prospectorContext?: string;
  reviewFindings?: ReviewProbe[];
}): string {
  const parts = [
    "Begin the interview. Call read_current_config first, then start the conversation about their business and targeting.",
  ];
  if (opts?.prospectorContext) parts.push(opts.prospectorContext);
  if (opts?.reviewFindings?.length) {
    parts.push(
      "## A sample run just tested the current ICP — raise these with the user:\n" +
        opts.reviewFindings
          .map((p) => `- ${p.topic}: ${p.observation}\n  Ask: ${p.askUser}`)
          .join("\n"),
    );
  }
  if (opts?.resumeSeed) parts.push(opts.resumeSeed);
  return parts.join("\n\n");
}

// The synthesis (phase 2 / prepared) kickoff: the source is either a rendered
// interview transcript or a filled questionnaire.
export function synthesisKickoff(source: string): string {
  return `Below is everything the user told you (a live interview transcript or a filled questionnaire). Read it, call read_current_config, then write the region, towns, categories, and ICP.\n\n----- INTERVIEW -----\n${source}\n----- END -----`;
}
