import { query, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  agentWorkspaceDir,
  blockedHosts,
  countRunWarnings,
  finishRun,
  formatCategoryPriorities,
  openRunLog,
  projectMessage,
  readCategoryConfig,
  recordFetch,
  readRegionConfig,
  startRun,
  type FindStatus,
  type RunEvent,
  type RunLogWriter,
} from "@localfinds/db";
import fs from "node:fs";
import path from "node:path";
import { buildLocalfindsServer, type RunCounters } from "./mcp-tools";
import { classifyWebFetchResult, hostOf, webFetchResultText } from "./web-fetch-log";
import { makePathGuard, makeWebFetchGuard } from "./path-guard";

// A scout host is hard-blocked after this many consecutive 403/401 outcomes.
const STRIKE_THRESHOLD = 3;

/** Default model for agents that don't pin their own. */
export const DEFAULT_MODEL = "claude-sonnet-4-6";

/**
 * Tell the agent where its workspace actually lives, as an absolute path. The
 * file tools require absolute paths but nothing else hands the agent its
 * absolute location, so on the first file access it guesses a root-anchored
 * path (e.g. `/notes/coverage.md`, `/workspace/notes/...`) that the path-guard
 * denies — wasting a turn every run until the denial message leaks the real
 * root and the agent retries (see runs 14 and 20). Handing it the prefix up
 * front removes that round-trip. Appended to every agent's system prompt;
 * stable per agent, so it stays cacheable.
 */
export function workspaceSystemNote(workspaceDir: string): string {
  return [
    "Your workspace is this absolute directory:",
    workspaceDir,
    "",
    "Read/Write/Edit/Glob/Grep require absolute paths, and you may only touch " +
      "files under that directory. Always build paths from it — your profile is " +
      `${workspaceDir}/profile.md and your notes live in ${workspaceDir}/notes/ ` +
      `(e.g. ${workspaceDir}/notes/coverage.md). Do NOT use root-anchored paths ` +
      "like /notes/... or /workspace/... — they resolve outside your workspace " +
      "and will be denied.",
  ].join("\n");
}

/** Reasoning effort (thinking depth). Lower = less thinking → cheaper & faster. */
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AgentDefinition {
  name: string;
  /** Tool names this agent may use (built-ins + mcp__localfinds__* subset). */
  allowedTools: string[];
  defaultMaxTurns: number;
  systemPrompt: string;
  /** Model id for this agent. Defaults to {@link DEFAULT_MODEL}. */
  model?: string;
  /**
   * Reasoning effort (thinking depth) for this agent. Lower means the model
   * thinks less — cheaper and faster, good for mechanical/ETL work. Omit for the
   * model default (high). Sonnet 4.6 supports low | medium | high | max.
   */
  effort?: ReasoningEffort;
  buildTaskPrompt(ctx: {
    region: string;
    profile: string;
    categories: string;
  }): string;
}

export interface RunOptions {
  maxTurns?: number;
  maxBudgetUsd?: number;
  /** Appended to the task prompt — used for dev/test runs. */
  extraPrompt?: string;
  /** Override the agent's reasoning effort (interview sample runs use "low"). */
  effort?: ReasoningEffort;
  /** Run in this workspace dir instead of the agent's default (interview staging). */
  workspaceDir?: string;
  /** Stamp save_find inserts with this status (interview runs pass "provisional"). */
  findStatusOverride?: FindStatus;
}

export interface RunOutcome {
  runId: number;
  result: SDKResultMessage | undefined;
  counters: RunCounters;
}

// Drop session markers from any parent Claude Code session so the spawned
// agent CLI doesn't inherit its project context (memory dirs, session ids).
// Exported (security-relevant, single definition) so the interviewer runner
// reuses the exact same stripping — note it removes every CLAUDE_* var, so any
// CLAUDE_* the child genuinely needs must be re-added on top, deliberately.
export function sanitizedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith("CLAUDE_") || key === "CLAUDECODE") continue;
    env[key] = value;
  }
  return env;
}

export function ensureWorkspace(workspace: string): string {
  fs.mkdirSync(path.join(workspace, "notes"), { recursive: true });
  const profilePath = path.join(workspace, "profile.md");
  if (!fs.existsSync(profilePath)) {
    const example = `${profilePath}.example`;
    if (fs.existsSync(example)) {
      fs.copyFileSync(example, profilePath);
    } else {
      fs.writeFileSync(profilePath, `# profile\n`);
    }
  }
  return workspace;
}

// Transcript writes are pure observability and, since SP4, a remote DB call
// over the SSH tunnel. A failed write must never abort or wedge a run
// (mirrors the recordFetch guard below) — log and continue.
async function safeWrite(log: RunLogWriter, event: RunEvent): Promise<void> {
  try {
    await log.write(event);
  } catch (err) {
    console.error(`run-events write failed (non-fatal):`, err);
  }
}

function logMessage(message: { type: string } & Record<string, any>): void {
  if (message.type !== "assistant") return;
  for (const block of message.message?.content ?? []) {
    if (block.type === "tool_use") {
      const brief = JSON.stringify(block.input)?.slice(0, 120);
      console.log(`  → ${block.name} ${brief}`);
    } else if (block.type === "text" && block.text.trim()) {
      console.log(`  ${block.text.trim().slice(0, 200)}`);
    }
  }
}

/**
 * Map a terminal SDK result to a run status. A budget cap
 * (`error_max_budget_usd`) is the intended guardrail — the agent works until it
 * runs out of money and its saves are already persisted — so it's "capped", a
 * normal outcome, not an "error". Anything else non-success is a real error.
 */
export function statusFromResult(
  result: SDKResultMessage | undefined,
): "success" | "capped" | "error" {
  if (!result) return "error";
  if (result.subtype === "success") return "success";
  if (result.subtype === "error_max_budget_usd") return "capped";
  return "error";
}

export async function runAgent(
  def: AgentDefinition,
  opts: RunOptions = {},
): Promise<RunOutcome> {
  const region = readRegionConfig();
  if (!region) {
    throw new Error(
      "Missing region config — copy data/config/region.md.example to region.md and fill it in.",
    );
  }

  const workspace = ensureWorkspace(opts.workspaceDir ?? agentWorkspaceDir(def.name));
  const profile = fs.readFileSync(path.join(workspace, "profile.md"), "utf8");
  const counters: RunCounters = { added: 0, updated: 0 };
  const maxTurns = opts.maxTurns ?? def.defaultMaxTurns;

  const categories = formatCategoryPriorities(readCategoryConfig());
  let prompt = def.buildTaskPrompt({ region: region.raw, profile, categories });
  if (maxTurns <= 10) {
    prompt +=
      "\n\nBudget note: this is a quick capped test run. Still do step 1 (feedback), then a minimal version of your remaining work: at most 2 web searches/fetches and at most 3 saving/updating tool calls, then stop and summarize.";
  }
  if (opts.extraPrompt) prompt += `\n\n${opts.extraPrompt}`;

  // Scout-only: skip hosts that have repeatedly 403/401'd. The prompt note avoids
  // wasting a turn on a denial; the PreToolUse guard (below) is the hard backstop.
  const isScout = def.name === "scout";
  const blocked = isScout ? await blockedHosts(STRIKE_THRESHOLD) : [];
  if (blocked.length > 0) {
    prompt +=
      "\n\n## Hosts to skip\n" +
      "These hosts repeatedly returned 403/401 and are blocked this run — do not fetch them:\n" +
      blocked.map((h) => `- ${h}`).join("\n");
  }
  const blockedSet = new Set(blocked);

  const model = def.model ?? DEFAULT_MODEL;
  const runId = await startRun(def.name);
  const log = openRunLog(def.name, runId);
  await safeWrite(log, {
    kind: "run_start",
    agent: def.name,
    runId,
    model,
    maxTurns,
    effort: def.effort,
  });
  console.log(
    `[${def.name}] run ${runId} starting ` +
      `(model=${model}, effort=${def.effort ?? "default"}, maxTurns=${maxTurns})`,
  );

  let result: SDKResultMessage | undefined;
  let warnings = 0;
  const fetchUrls = new Map<string, string>(); // WebFetch tool_use id -> url
  try {
    for await (const message of query({
      prompt,
      options: {
        model,
        effort: opts.effort ?? def.effort,
        cwd: workspace,
        env: sanitizedEnv(),
        systemPrompt: `${def.systemPrompt}\n\n${workspaceSystemNote(workspace)}`,
        settingSources: [],
        // The CLI's auto-memory resolves to the enclosing git repo and would
        // surface the developer's Claude session memory into agent context.
        settings: { autoMemoryEnabled: false },
        permissionMode: "bypassPermissions",
        mcpServers: {
          localfinds: buildLocalfindsServer(def.name, counters, {
            findStatusOverride: opts.findStatusOverride,
          }),
        },
        allowedTools: def.allowedTools,
        disallowedTools: ["Bash", "Agent", "Task", "AskUserQuestion"],
        maxTurns,
        maxBudgetUsd: opts.maxBudgetUsd ?? 1.0,
        hooks: {
          PreToolUse: [
            {
              matcher: "Read|Write|Edit|Glob|Grep",
              hooks: [makePathGuard(workspace)],
            },
            {
              matcher: "WebFetch",
              hooks: [makeWebFetchGuard(blockedSet)],
            },
          ],
        },
      },
    })) {
      logMessage(message as never);
      const events = projectMessage(message);
      for (const ev of events) {
        await safeWrite(log, ev);
        if (isScout && ev.kind === "tool_use" && ev.name === "WebFetch") {
          const url = (ev.input as { url?: unknown })?.url;
          if (typeof url === "string") fetchUrls.set(ev.id, url);
        } else if (isScout && ev.kind === "tool_result" && fetchUrls.has(ev.toolUseId)) {
          const url = fetchUrls.get(ev.toolUseId)!;
          fetchUrls.delete(ev.toolUseId);
          const host = hostOf(url);
          if (host) {
            // Logging must never fail a run.
            try {
              const { klass, status } = classifyWebFetchResult(webFetchResultText(ev.content));
              await recordFetch({ runId, agent: def.name, host, url, status, klass });
            } catch (err) {
              console.error(`[${def.name}] recordFetch failed:`, err);
            }
          }
        }
      }
      warnings += countRunWarnings(events);
      if (message.type === "result") result = message;
    }

    const status = statusFromResult(result);
    await safeWrite(log, { kind: "run_end", status });
    await log.close();
    await finishRun(runId, {
      status,
      itemsAdded: counters.added,
      itemsUpdated: counters.updated,
      warnings,
      numTurns: result?.num_turns,
      costUsd: result?.total_cost_usd,
      usageJson: result ? JSON.stringify(result.modelUsage) : undefined,
      sessionId: result?.session_id,
      error: status === "error" ? result?.subtype : undefined,
    });
  } catch (err) {
    // The SDK yields the terminal result message (e.g. error_max_budget_usd or
    // error_max_turns), then throws when the CLI process exits non-zero — keep
    // the captured stats. A budget cap is the intended guardrail, so it lands
    // here as a "capped" (non-error) run that already persisted its finds.
    const status = statusFromResult(result);
    const message = err instanceof Error ? err.message : String(err);
    if (status === "error") await safeWrite(log, { kind: "error", message });
    await safeWrite(log, { kind: "run_end", status });
    await log.close();
    await finishRun(runId, {
      status,
      itemsAdded: counters.added,
      itemsUpdated: counters.updated,
      warnings,
      numTurns: result?.num_turns,
      costUsd: result?.total_cost_usd,
      usageJson: result ? JSON.stringify(result.modelUsage) : undefined,
      sessionId: result?.session_id,
      error: status === "error" ? (result?.subtype ?? message) : undefined,
    });
    if (!result) throw err;
  }

  console.log(
    `[${def.name}] run ${runId} ${result?.subtype ?? "no-result"}: ` +
      `${counters.added} added, ${counters.updated} updated, ` +
      `${result?.num_turns ?? "?"} turns, $${result?.total_cost_usd?.toFixed(4) ?? "?"}`,
  );
  if (result && result.permission_denials.length > 0) {
    console.log(
      `[${def.name}] permission denials:`,
      JSON.stringify(result.permission_denials),
    );
  }
  return { runId, result, counters };
}
