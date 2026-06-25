// `npm run interview` — the interviewer's runner. Selects a path (interactive vs.
// prepared) BEFORE any query() runs, builds a surface-appropriate InterviewIO,
// drives one query(), and gates every config write behind a real before/after
// diff the user confirms.
//
// The pure helpers (parseInterviewArgs, isQuestionnaireFilled, lineDiff) are
// exported and unit-tested; main() is the I/O shell (SDK + readline), verified
// end-to-end by hand. main() only runs when this file is the entry point, so
// importing it for tests is side-effect-free.

import { query, type SDKMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import {
  agentWorkspaceDir,
  categoryConfigPath,
  dataDir,
  discardProvisionalFinds,
  icpProfilePath,
  promoteProvisionalFinds,
  regionConfigPath,
  setConfigDirOverride,
  townsConfigPath,
} from "@localfinds/db";
import { loadEnv } from "./env";
import { runAgent, sanitizedEnv, type ReasoningEffort, type RunOptions } from "./run-agent";
import { prospector } from "./agents/prospector";
import {
  buildInterviewerServer,
  buildReviewServer,
  type InterviewIO,
  type ReviewContext,
  type ReviewProbe,
  type ReviewResult,
  type ReviewSink,
} from "./interview-tools";
import { createStagingDir, discardStaging, promoteStaging, seedStaging } from "./interview-staging";
import {
  appendEntry,
  archiveJournal,
  readJournal,
  renderTranscript,
  summarizeForResume,
} from "./interview-journal";
import { recentProspectorContext } from "./prospector-context";
import {
  COLLECTION_SYSTEM_PROMPT,
  COLLECTION_TOOLS,
  INTERVIEWER_COLLECTION_EFFORT,
  INTERVIEWER_DISALLOWED,
  INTERVIEWER_MODEL,
  INTERVIEWER_SYNTHESIS_EFFORT,
  QUESTIONNAIRE_TEMPLATE,
  REVIEW_SYSTEM_PROMPT,
  REVIEW_TOOLS,
  SYNTHESIS_SYSTEM_PROMPT,
  SYNTHESIS_TOOLS,
  collectionKickoff,
  reviewKickoff,
  synthesisKickoff,
} from "./agents/interviewer";

// --- Pure helpers (unit-tested) ---

export type InterviewDepth = "brief" | "medium" | "comprehensive";

const DEPTHS: InterviewDepth[] = ["brief", "medium", "comprehensive"];

export function parseInterviewArgs(argv: string[]): { prepared: boolean; depth: InterviewDepth } {
  const depthArg = argv.find((a) => a.startsWith("--depth="))?.slice("--depth=".length);
  const depth = DEPTHS.includes(depthArg as InterviewDepth) ? (depthArg as InterviewDepth) : "brief";
  return { prepared: argv.includes("--prepared"), depth };
}

// brief = final cycle only; medium/comprehensive add 1/2 throwaway cycles first.
export function preliminaryCycles(depth: InterviewDepth): number {
  return { brief: 0, medium: 1, comprehensive: 2 }[depth];
}

// Filled = at least one "Answer:" line has text on the SAME line. [ \t]* (not
// \s*) keeps the match from spilling onto the next section's heading.
export function isQuestionnaireFilled(content: string): boolean {
  return /^Answer:[ \t]*\S/m.test(content);
}

// A compact line diff: trims the common prefix/suffix, then shows removed lines
// with "- " and added lines with "+ ". Empty string means no change.
export function lineDiff(before: string, after: string): string {
  if (before === after) return "";
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const removed = a.slice(start, endA).map((l) => `- ${l}`);
  const added = b.slice(start, endB).map((l) => `+ ${l}`);
  return [...removed, ...added].join("\n");
}

// A deliberately tiny prospector pass for the interview loop: one quick capped
// run (runAgent's maxTurns<=10 path already caps it to ~2 fetches / ~3 saves),
// low effort, reading the staged ICP and writing provisional leads to the real DB.
export function sampleRunOptions(stagingDir: string): RunOptions {
  return {
    maxTurns: 8,
    effort: "low",
    workspaceDir: path.join(stagingDir, "agents", "prospector"),
    findStatusOverride: "provisional",
  };
}

// Run the sample pass with config reads pointed at staging. The DB stays real
// (provisional leads land in the real finds table), so we override only the
// config dir, and always restore it.
async function runProspectorSample(
  stagingDir: string,
): Promise<{ runId: number; status: string }> {
  process.stdout.write("\nRunning a quick prospector pass against this profile…\n");
  setConfigDirOverride(stagingDir);
  try {
    const { runId, result } = await runAgent(prospector, sampleRunOptions(stagingDir));
    return { runId, status: result?.subtype ?? "error" };
  } finally {
    setConfigDirOverride(undefined);
  }
}

// Run the review phase: reads staged config + run results, submits a report with
// probes for the next conversation (or an empty probe list on the final cycle).
async function runReview(
  io: InterviewIO,
  transcript: string,
  scratchDir: string,
  run: { runId: number; status: string },
  effort: ReasoningEffort,
  isFinal: boolean,
): Promise<ReviewResult> {
  const sink: ReviewSink = {};
  const ctx: ReviewContext = { runId: run.runId, scratchDir };
  process.stdout.write("\nReviewing the run against your answers…\n");
  try {
    for await (const message of query({
      prompt: reviewKickoff({ transcript, runId: run.runId, runStatus: run.status, isFinal }),
      options: {
        model: INTERVIEWER_MODEL,
        effort,
        env: interviewerEnv(),
        systemPrompt: REVIEW_SYSTEM_PROMPT,
        settingSources: [],
        settings: { autoMemoryEnabled: false },
        permissionMode: "bypassPermissions",
        mcpServers: { interviewer: buildReviewServer(io, ctx, sink) },
        allowedTools: REVIEW_TOOLS,
        disallowedTools: INTERVIEWER_DISALLOWED,
        maxTurns: 20,
      },
    })) {
      logMessage(message);
    }
  } catch (err) {
    console.error("\nReview ended early:", err instanceof Error ? err.message : err);
  }
  return sink.value ?? { report: "", calibration: "", probes: [] };
}

// --- Cycle sub-steps ---

async function runConvo(
  io: InterviewIO,
  kickoff: { resumeSeed?: string; prospectorContext?: string; reviewFindings?: ReviewProbe[] },
): Promise<SDKResultMessage | undefined> {
  let collected: SDKResultMessage | undefined;
  try {
    for await (const message of query({
      prompt: collectionKickoff(kickoff),
      options: {
        model: INTERVIEWER_MODEL,
        effort: INTERVIEWER_COLLECTION_EFFORT,
        env: interviewerEnv(),
        systemPrompt: COLLECTION_SYSTEM_PROMPT,
        settingSources: [],
        settings: { autoMemoryEnabled: false },
        permissionMode: "bypassPermissions",
        mcpServers: { interviewer: buildInterviewerServer(io) },
        allowedTools: COLLECTION_TOOLS,
        disallowedTools: INTERVIEWER_DISALLOWED,
        maxTurns: 200,
      },
    })) {
      logMessage(message);
      if (message.type === "result") collected = message;
    }
  } catch (err) {
    console.error("\nInterview run ended early:", err instanceof Error ? err.message : err);
  }
  return collected;
}

async function runBuild(
  io: InterviewIO,
  transcript: string,
  effort: ReasoningEffort,
): Promise<SDKResultMessage | undefined> {
  let written: SDKResultMessage | undefined;
  try {
    for await (const message of query({
      prompt: synthesisKickoff(transcript),
      options: {
        model: INTERVIEWER_MODEL,
        effort,
        env: interviewerEnv(),
        systemPrompt: SYNTHESIS_SYSTEM_PROMPT,
        settingSources: [],
        settings: { autoMemoryEnabled: false },
        permissionMode: "bypassPermissions",
        mcpServers: { interviewer: buildInterviewerServer(io) },
        allowedTools: SYNTHESIS_TOOLS,
        disallowedTools: INTERVIEWER_DISALLOWED,
        maxTurns: 60,
      },
    })) {
      logMessage(message);
      if (message.type === "result") written = message;
    }
  } catch (err) {
    console.error("\nWriting the config ended early:", err instanceof Error ? err.message : err);
  }
  return written;
}

// --- The confirm-before-write diff gate ---
//
// This snapshot/restore machinery backs the PREPARED path (runPrepared); the
// interactive path uses a staging dir instead.
//
// The four target files are hand-tuned and production-bound (sync-content.sh
// rsyncs data/ to the live site), so a silent drop/rename must be visible before
// the user commits. set_towns needs a written region to derive its state, so a
// pure "buffer all, commit on confirm" can't work; instead we snapshot the files,
// let the agent write live, then show one cumulative diff and revert on reject.

interface TargetFile {
  label: string;
  path: string;
}

function targetConfigFiles(): TargetFile[] {
  return [
    { label: "data/config/region.md", path: regionConfigPath() },
    { label: "data/config/towns.json", path: townsConfigPath() },
    { label: "data/config/categories.json", path: categoryConfigPath() },
    { label: "data/agents/prospector/profile.md", path: icpProfilePath() },
  ];
}

function readOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function snapshot(files: TargetFile[]): Map<string, string | null> {
  const m = new Map<string, string | null>();
  for (const f of files) m.set(f.path, readOrNull(f.path));
  return m;
}

function restore(files: TargetFile[], before: Map<string, string | null>): void {
  for (const f of files) {
    const orig = before.get(f.path) ?? null;
    if (orig === null) {
      try {
        fs.rmSync(f.path);
      } catch {
        // wasn't created — nothing to undo
      }
    } else {
      fs.writeFileSync(f.path, orig);
    }
  }
}

function rlQuestion(rl: readline.Interface, q: string): Promise<string> {
  return new Promise((resolve) => rl.question(q, resolve));
}

// A filesystem-safe, sortable name for an archived interview transcript
// (e.g. "2026-06-24T15-42-03Z"). Colons would be invalid on some filesystems.
function interviewRunId(): string {
  return new Date().toISOString().replace(/:/g, "-").replace(/\.\d+Z$/, "Z");
}

// Show the cumulative diff and ask the user to keep or revert. Returns true to
// keep. A run with no changes is reported and treated as "kept" (nothing to do).
async function reviewAndConfirm(
  rl: readline.Interface,
  files: TargetFile[],
  before: Map<string, string | null>,
): Promise<boolean> {
  const changed = files
    .map((f) => {
      const beforeContent = before.get(f.path) ?? "";
      const afterContent = readOrNull(f.path) ?? "";
      return { label: f.label, diff: lineDiff(beforeContent, afterContent) };
    })
    .filter((c) => c.diff !== "");

  if (changed.length === 0) {
    process.stdout.write("\nNo configuration changes were made.\n");
    return true;
  }

  process.stdout.write("\n===== Proposed changes =====\n");
  for (const c of changed) {
    process.stdout.write(`\n--- ${c.label} ---\n${c.diff}\n`);
  }
  const ans = (await rlQuestion(rl, "\nKeep these changes? (y/N) ")).trim().toLowerCase();
  return ans === "y" || ans === "yes";
}

// --- SDK plumbing ---

// sanitizedEnv strips every CLAUDE_* var (security). The interviewer's blocking
// ask_user tool can wait minutes for a human, well past the SDK's 60s default, so
// we DELIBERATELY re-add a generous CLAUDE_CODE_STREAM_CLOSE_TIMEOUT on top — do
// NOT "clean this up" (Issue 10). Prepared generation can also exceed 60s
// (geocoding ~19 towns at ≤1 req/s), so both paths set it.
function interviewerEnv(): Record<string, string> {
  return { ...sanitizedEnv(), CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: "3600000" };
}

function logMessage(message: SDKMessage): void {
  if (message.type !== "assistant") return;
  const content = (message as { message?: { content?: { type: string; text?: string; name?: string }[] } })
    .message?.content;
  for (const block of content ?? []) {
    if (block.type === "text" && block.text?.trim()) {
      process.stdout.write(`\n${block.text.trim()}\n`);
    } else if (block.type === "tool_use" && block.name) {
      process.stdout.write(`  → ${block.name}\n`);
    }
  }
}

// Diff each real config artifact against its staged version and ask to keep.
async function confirmStaging(
  rl: readline.Interface,
  dataRoot: string,
  stagingDir: string,
): Promise<boolean> {
  const rels = [
    { label: "data/config/region.md", rel: "config/region.md" },
    { label: "data/config/towns.json", rel: "config/towns.json" },
    { label: "data/config/categories.json", rel: "config/categories.json" },
    { label: "data/agents/prospector/profile.md", rel: "agents/prospector/profile.md" },
  ];
  const changed = rels
    .map((f) => ({
      label: f.label,
      diff: lineDiff(
        readOrNull(path.join(dataRoot, f.rel)) ?? "",
        readOrNull(path.join(stagingDir, f.rel)) ?? "",
      ),
    }))
    .filter((c) => c.diff !== "");

  if (changed.length === 0) {
    process.stdout.write("\nNo configuration changes were made.\n");
    return true;
  }
  process.stdout.write("\n===== Proposed changes =====\n");
  for (const c of changed) process.stdout.write(`\n--- ${c.label} ---\n${c.diff}\n`);
  const ans = (await rlQuestion(rl, "\nKeep these changes? (y/N) ")).trim().toLowerCase();
  return ans === "y" || ans === "yes";
}

// --- Path: interactive ---

async function runInteractive(depth: InterviewDepth): Promise<void> {
  process.stdout.write(
    "\nNo clock here — take as long as you like. I'll ask about your business and\n" +
      "who you're trying to reach, run a quick test pass, and show you every change\n" +
      "before anything saves.\n\n",
  );
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const io: InterviewIO = {
    ask: async (question, opts) => {
      appendEntry({ role: "agent", kind: "ask", text: question });
      const hint = opts?.choices?.length ? ` [${opts.choices.join(" / ")}]` : "";
      const answer = await rlQuestion(rl, `\n${question}${hint}\n> `);
      appendEntry({ role: "user", kind: "answer", text: answer });
      process.stdout.write("\n  · got it — thinking…\n");
      return answer;
    },
    say: (message) => {
      appendEntry({ role: "agent", kind: "say", text: message });
      process.stdout.write(`\n${message}\n`);
    },
  };

  const prior = readJournal();
  const seed = prior.length ? summarizeForResume(prior) : undefined;
  if (seed) process.stdout.write("Resuming your earlier interview — picking up where you left off.\n");

  const dataRoot = dataDir();
  const runId = interviewRunId();
  const staging = createStagingDir(dataRoot, runId);
  seedStaging(dataRoot, staging);
  const prospectorContext = recentProspectorContext();

  const totalCycles = preliminaryCycles(depth) + 1;
  let lastReview: ReviewResult | undefined;
  let lastTranscript = "";

  for (let c = 0; c < totalCycles; c++) {
    const isFinal = c === totalCycles - 1;
    const buildEffort: ReasoningEffort = isFinal ? "high" : "low";
    const reviewEffort: ReasoningEffort = isFinal ? "high" : "low";
    process.stdout.write(`\n===== Cycle ${c + 1} of ${totalCycles}${isFinal ? " (final)" : ""} =====\n`);

    // ── CONVO ──
    const convo = await runConvo(io, {
      resumeSeed: c === 0 ? seed : undefined,
      prospectorContext: prospectorContext || undefined,
      reviewFindings: lastReview?.probes,
    });
    if (convo?.subtype !== "success") {
      process.stdout.write(
        "\nThe interview didn't finish. Re-run `npm run interview` to resume where you left off.\n",
      );
      discardProvisionalFinds();
      discardStaging(staging);
      rl.close();
      return;
    }
    lastTranscript = renderTranscript(readJournal());
    if (!lastTranscript.trim()) {
      process.stdout.write("\nNo answers were captured, so there's nothing to write.\n");
      discardProvisionalFinds();
      discardStaging(staging);
      rl.close();
      return;
    }

    // ── BUILD (writes to staging) ──
    process.stdout.write("\nWriting up your targeting and ICP for this pass…\n");
    setConfigDirOverride(staging);
    let built: SDKResultMessage | undefined;
    try {
      built = await runBuild(io, lastTranscript, buildEffort);
    } finally {
      setConfigDirOverride(undefined);
    }
    if (built?.subtype !== "success") {
      process.stdout.write("\nI couldn't write the config from the interview this pass.\n");
      discardStaging(staging);
      discardProvisionalFinds();
      rl.close();
      return;
    }

    // ── RUN (provisional leads; clear any from a prior cycle first) ──
    discardProvisionalFinds();
    const run = await runProspectorSample(staging);

    // ── REVIEW ──
    lastReview = await runReview(
      io,
      lastTranscript,
      path.join(staging, "agents", "prospector"),
      run,
      reviewEffort,
      isFinal,
    );
  }

  // ── FINAL GATE ──
  const keep = await confirmStaging(rl, dataRoot, staging);
  if (keep) {
    promoteStaging(dataRoot, staging);
    const promoted = promoteProvisionalFinds();
    discardStaging(staging);
    const archived = archiveJournal(runId);
    process.stdout.write(
      `\nSaved${promoted ? ` — ${promoted} lead(s) added to your feed` : ""}. ` +
        "Run `npm run agent -- prospector` for a full pass.\n",
    );
    if (archived) process.stdout.write(`Transcript kept at ${path.relative(process.cwd(), archived)}\n`);
  } else {
    discardStaging(staging);
    discardProvisionalFinds();
    process.stdout.write("\nReverted — your earlier config is unchanged.\n");
  }
  rl.close();
}

// --- Path: prepared questionnaire ---

async function runPrepared(): Promise<void> {
  const qPath = path.join(agentWorkspaceDir("interviewer"), "questionnaire.md");
  const content = readOrNull(qPath);

  if (content === null || !isQuestionnaireFilled(content)) {
    fs.mkdirSync(path.dirname(qPath), { recursive: true });
    if (content === null) fs.writeFileSync(qPath, QUESTIONNAIRE_TEMPLATE);
    process.stdout.write(
      `\nQuestionnaire is ready at:\n  ${qPath}\n\n` +
        'Fill in every "Answer:" line, then re-run `npm run interview -- --prepared`.\n',
    );
    return;
  }

  // No live questions in prepared mode — ask_user is removed from the tool list,
  // so io.ask should never fire; throw loudly if the model somehow tries.
  const io: InterviewIO = {
    ask: async () => {
      throw new Error("ask_user is not available in prepared mode");
    },
    say: (message) => process.stdout.write(`\n${message}\n`),
  };

  const files = targetConfigFiles();
  const before = snapshot(files);

  let result: SDKResultMessage | undefined;
  try {
    for await (const message of query({
      prompt: synthesisKickoff(content),
      options: {
        model: INTERVIEWER_MODEL,
        effort: INTERVIEWER_SYNTHESIS_EFFORT,
        env: interviewerEnv(),
        systemPrompt: SYNTHESIS_SYSTEM_PROMPT,
        settingSources: [],
        settings: { autoMemoryEnabled: false },
        permissionMode: "bypassPermissions",
        mcpServers: { interviewer: buildInterviewerServer(io) },
        allowedTools: SYNTHESIS_TOOLS,
        disallowedTools: INTERVIEWER_DISALLOWED,
        maxTurns: 40,
      },
    })) {
      logMessage(message);
      if (message.type === "result") result = message;
    }
  } catch (err) {
    console.error("\nGeneration ended early:", err instanceof Error ? err.message : err);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  if (result?.subtype === "success") {
    const keep = await reviewAndConfirm(rl, files, before);
    if (keep) {
      process.stdout.write("\nSaved. Run `npm run agent -- prospector` to generate your first leads.\n");
    } else {
      restore(files, before);
      process.stdout.write("\nReverted — your earlier config is unchanged.\n");
    }
  } else {
    process.stdout.write(
      "\nGeneration didn't finish — check your questionnaire answers and re-run.\n",
    );
  }
  rl.close();
}

async function main(): Promise<void> {
  loadEnv();
  const { prepared, depth } = parseInterviewArgs(process.argv.slice(2));
  if (prepared) await runPrepared();
  else await runInteractive(depth);
}

// Only launch when run as the entry point (`tsx src/interview.ts`); importing
// this module for tests must not start an interview.
const isEntryPoint =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) void main();
