import { query, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  agentWorkspaceDir,
  finishRun,
  readRegionConfig,
  startRun,
} from "@localfinds/db";
import fs from "node:fs";
import path from "node:path";
import { buildLocalfindsServer, type RunCounters } from "./mcp-tools";
import { makePathGuard } from "./path-guard";

export interface AgentDefinition {
  name: string;
  /** Tool names this agent may use (built-ins + mcp__localfinds__* subset). */
  allowedTools: string[];
  defaultMaxTurns: number;
  systemPrompt: string;
  buildTaskPrompt(ctx: { region: string; profile: string }): string;
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

  let prompt = def.buildTaskPrompt({ region: region.raw, profile });
  if (maxTurns <= 10) {
    prompt +=
      "\n\nBudget note: this is a quick capped test run. Skip notes upkeep, do at most 2 web searches, save at most 3 finds, then stop and summarize.";
  }
  if (opts.extraPrompt) prompt += `\n\n${opts.extraPrompt}`;

  const runId = startRun(def.name);
  console.log(`[${def.name}] run ${runId} starting (maxTurns=${maxTurns})`);

  let result: SDKResultMessage | undefined;
  try {
    for await (const message of query({
      prompt,
      options: {
        model: "claude-sonnet-4-6",
        cwd: workspace,
        systemPrompt: def.systemPrompt,
        settingSources: [],
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
      if (message.type === "result") result = message;
    }

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
