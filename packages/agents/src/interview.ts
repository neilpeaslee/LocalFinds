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
  icpProfilePath,
  regionConfigPath,
  setConfigDirOverride,
  townsConfigPath,
} from "@localfinds/db";
import { loadEnv } from "./env";
import { runAgent, sanitizedEnv, type RunOptions } from "./run-agent";
import { prospector } from "./agents/prospector";
import { buildInterviewerServer, type InterviewIO } from "./interview-tools";
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
  SYNTHESIS_SYSTEM_PROMPT,
  SYNTHESIS_TOOLS,
  collectionKickoff,
  synthesisKickoff,
} from "./agents/interviewer";

// --- Pure helpers (unit-tested) ---

export function parseInterviewArgs(argv: string[]): { prepared: boolean } {
  return { prepared: argv.includes("--prepared") };
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

// --- The confirm-before-write diff gate ---
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

// --- Path: interactive ---

async function runInteractive(): Promise<void> {
  process.stdout.write(
    "\nNo clock here — take as long as you like. I'll ask about your business and\n" +
      "who you're trying to reach, then show you every change before anything saves.\n\n",
  );
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // Each ask/answer is journaled synchronously so a Ctrl-C loses nothing.
  const io: InterviewIO = {
    ask: async (question, opts) => {
      appendEntry({ role: "agent", kind: "ask", text: question });
      const hint = opts?.choices?.length ? ` [${opts.choices.join(" / ")}]` : "";
      const answer = await rlQuestion(rl, `\n${question}${hint}\n> `);
      appendEntry({ role: "user", kind: "answer", text: answer });
      // Instant feedback: the model now thinks (silently) before its next turn, so
      // acknowledge the moment they hit enter — a keystroke must never vanish into
      // dead air while the agent reasons.
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

  const files = targetConfigFiles();
  const before = snapshot(files);

  // --- Phase 1: collection — a snappy live conversation that writes nothing ---
  // Ground a refinement interview in what the prospector actually found ("" on a
  // true cold start, so the section is simply omitted).
  const prospectorContext = recentProspectorContext();
  let collected: SDKResultMessage | undefined;
  try {
    for await (const message of query({
      prompt: collectionKickoff({ resumeSeed: seed, prospectorContext: prospectorContext || undefined }),
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
        // Every ask_user blocks on a human, so this can't run away; it only
        // backstops a non-interactive tool loop. Kept well above a thorough
        // conversation so the agent never rushes to wrap up before the cap — the
        // invisible "hidden timer" that ended an earlier run at ~80%. No
        // maxBudgetUsd: a mid-interview budget kill is a bad UX (Issue 6).
        maxTurns: 200,
      },
    })) {
      logMessage(message);
      if (message.type === "result") collected = message;
    }
  } catch (err) {
    console.error("\nInterview run ended early:", err instanceof Error ? err.message : err);
  }

  if (collected?.subtype !== "success") {
    process.stdout.write(
      "\nThe interview didn't finish. Re-run `npm run interview` to resume where you left off.\n",
    );
    rl.close();
    return;
  }

  const transcript = renderTranscript(readJournal());
  if (!transcript.trim()) {
    process.stdout.write(
      "\nNo answers were captured, so there's nothing to write. Re-run `npm run interview` to start over.\n",
    );
    rl.close();
    return;
  }

  // --- Phase 2: synthesis — a deeper pass that writes the config from the
  // transcript. The one slow step, confined to the end where a wait is expected. ---
  process.stdout.write("\nThanks — writing up your targeting and ICP now. This part takes a moment…\n");
  let written: SDKResultMessage | undefined;
  try {
    for await (const message of query({
      prompt: synthesisKickoff(transcript),
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
        maxTurns: 60,
      },
    })) {
      logMessage(message);
      if (message.type === "result") written = message;
    }
  } catch (err) {
    console.error("\nWriting the config ended early:", err instanceof Error ? err.message : err);
  }

  if (written?.subtype === "success") {
    const keep = await reviewAndConfirm(rl, files, before);
    if (keep) {
      // Archive (not delete) the journal: the transcript survives under runs/ for
      // later review, and moving it clears the live journal so the next interview
      // still starts fresh.
      const archived = archiveJournal(interviewRunId());
      process.stdout.write("\nSaved. Run `npm run agent -- prospector` to generate your first leads.\n");
      if (archived) {
        process.stdout.write(`Transcript kept at ${path.relative(process.cwd(), archived)}\n`);
      }
    } else {
      restore(files, before);
      // Journal kept (not cleared) so a re-run resumes from your answers.
      process.stdout.write(
        "\nReverted — your earlier config is unchanged. Re-run `npm run interview` to resume and adjust.\n",
      );
    }
  } else {
    // A failed/partial synthesis must not leave unconfirmed writes behind.
    restore(files, before);
    process.stdout.write(
      "\nI couldn't finish writing the config from the interview — your earlier config is unchanged. Re-run `npm run interview` to try again (your answers are saved).\n",
    );
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
  const { prepared } = parseInterviewArgs(process.argv.slice(2));
  if (prepared) await runPrepared();
  else await runInteractive();
}

// Only launch when run as the entry point (`tsx src/interview.ts`); importing
// this module for tests must not start an interview.
const isEntryPoint =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) void main();
