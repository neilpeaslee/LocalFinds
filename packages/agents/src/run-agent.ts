import { query, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  agentWorkspaceDir,
  countRunWarnings,
  dedupeBusinesses,
  finishRun,
  formatCategoryPriorities,
  openRunLog,
  projectMessage,
  readCategoryConfig,
  readRegionConfig,
  startRun,
} from "@localfinds/db";
import fs from "node:fs";
import path from "node:path";
import { buildLocalfindsServer, type RunCounters } from "./mcp-tools";
import { makePathGuard } from "./path-guard";

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
}

export interface RunOutcome {
  runId: number;
  result: SDKResultMessage | undefined;
  counters: RunCounters;
}

// Drop session markers from any parent Claude Code session so the spawned
// agent CLI doesn't inherit its project context (memory dirs, session ids).
function sanitizedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith("CLAUDE_") || key === "CLAUDECODE") continue;
    env[key] = value;
  }
  return env;
}

function ensureWorkspace(name: string): string {
  const workspace = agentWorkspaceDir(name);
  fs.mkdirSync(path.join(workspace, "notes"), { recursive: true });
  const profilePath = path.join(workspace, "profile.md");
  if (!fs.existsSync(profilePath)) {
    const example = `${profilePath}.example`;
    if (fs.existsSync(example)) {
      fs.copyFileSync(example, profilePath);
    } else {
      fs.writeFileSync(profilePath, `# ${name} profile\n`);
    }
  }
  return workspace;
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

  const workspace = ensureWorkspace(def.name);
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

  const model = def.model ?? DEFAULT_MODEL;
  const runId = startRun(def.name);
  const log = openRunLog(def.name, runId);
  log.write({
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
  try {
    for await (const message of query({
      prompt,
      options: {
        model,
        effort: def.effort,
        cwd: workspace,
        env: sanitizedEnv(),
        systemPrompt: `${def.systemPrompt}\n\n${workspaceSystemNote(workspace)}`,
        settingSources: [],
        // The CLI's auto-memory resolves to the enclosing git repo and would
        // surface the developer's Claude session memory into agent context.
        settings: { autoMemoryEnabled: false },
        permissionMode: "bypassPermissions",
        mcpServers: {
          localfinds: buildLocalfindsServer(def.name, counters),
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
          ],
        },
      },
    })) {
      logMessage(message as never);
      const events = projectMessage(message);
      for (const ev of events) log.write(ev);
      warnings += countRunWarnings(events);
      if (message.type === "result") result = message;
    }

    const status = statusFromResult(result);
    log.write({ kind: "run_end", status });
    log.close();
    finishRun(runId, {
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
    // Deterministic post-run housekeeping: collapse OSM duplicate elements the
    // scan may have introduced. Cartographer-only; never LLM-triggered. A
    // failure here must not fail an otherwise-successful run.
    if (status === "success" && def.name === "cartographer") {
      try {
        const summary = dedupeBusinesses();
        console.log(
          `[${def.name}] dedupe: marked ${summary.marked} duplicate(s) across ${summary.groups} group(s)`,
        );
      } catch (err) {
        console.error(`[${def.name}] dedupe sweep failed:`, err);
      }
    }
  } catch (err) {
    // The SDK yields the terminal result message (e.g. error_max_budget_usd or
    // error_max_turns), then throws when the CLI process exits non-zero — keep
    // the captured stats. A budget cap is the intended guardrail, so it lands
    // here as a "capped" (non-error) run that already persisted its finds.
    const status = statusFromResult(result);
    const message = err instanceof Error ? err.message : String(err);
    if (status === "error") log.write({ kind: "error", message });
    log.write({ kind: "run_end", status });
    log.close();
    finishRun(runId, {
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
