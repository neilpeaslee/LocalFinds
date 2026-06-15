import { query, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  agentWorkspaceDir,
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
  try {
    for await (const message of query({
      prompt,
      options: {
        model,
        effort: def.effort,
        cwd: workspace,
        env: sanitizedEnv(),
        systemPrompt: def.systemPrompt,
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
      for (const ev of projectMessage(message)) log.write(ev);
      if (message.type === "result") result = message;
    }

    const status = result?.subtype === "success" ? "success" : "error";
    log.write({ kind: "run_end", status });
    log.close();
    finishRun(runId, {
      status: result?.subtype === "success" ? "success" : "error",
      itemsAdded: counters.added,
      itemsUpdated: counters.updated,
      numTurns: result?.num_turns,
      costUsd: result?.total_cost_usd,
      usageJson: result ? JSON.stringify(result.modelUsage) : undefined,
      sessionId: result?.session_id,
      error:
        result && result.subtype !== "success" ? result.subtype : undefined,
    });
  } catch (err) {
    // The SDK yields the error result message (e.g. error_max_turns), then
    // throws when the CLI process exits non-zero — keep the captured stats.
    log.write({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    log.write({ kind: "run_end", status: "error" });
    log.close();
    finishRun(runId, {
      status: "error",
      itemsAdded: counters.added,
      itemsUpdated: counters.updated,
      numTurns: result?.num_turns,
      costUsd: result?.total_cost_usd,
      usageJson: result ? JSON.stringify(result.modelUsage) : undefined,
      sessionId: result?.session_id,
      error:
        result?.subtype ?? (err instanceof Error ? err.message : String(err)),
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
