import { loadEnv } from "./env";
import { runAgent, type AgentDefinition, type RunOptions } from "./run-agent";
import { curator } from "./agents/curator";
import { prospector } from "./agents/prospector";
import { scout } from "./agents/scout";
import { sourceKeeper } from "./agents/source-keeper";

const registry: Record<string, AgentDefinition> = {
  scout,
  "source-keeper": sourceKeeper,
  prospector,
  curator,
};
// prospector runs before curator (so curator prunes leads the same cycle).
const rosterOrder = [
  "scout",
  "source-keeper",
  "prospector",
  "curator",
];

function parseArgs(argv: string[]): { target: string; opts: RunOptions } {
  const [target, ...rest] = argv;
  const opts: RunOptions = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--max-turns") opts.maxTurns = Number(rest[++i]);
    else if (rest[i] === "--max-budget-usd")
      opts.maxBudgetUsd = Number(rest[++i]);
    else if (rest[i] === "--extra-prompt") opts.extraPrompt = rest[++i];
    else throw new Error(`Unknown argument: ${rest[i]}`);
  }
  return { target: target ?? "", opts };
}

async function main(): Promise<void> {
  loadEnv();
  const { target, opts } = parseArgs(process.argv.slice(2));

  const names =
    target === "all"
      ? rosterOrder.filter((name) => name in registry)
      : [target];

  if (!target || names.some((name) => !(name in registry))) {
    console.error(
      `Usage: agent <${Object.keys(registry).join("|")}|all> [--max-turns N] [--max-budget-usd X] [--extra-prompt "..."]`,
    );
    process.exit(2);
  }

  let failed = false;
  for (const name of names) {
    try {
      const { result } = await runAgent(registry[name], opts);
      if (result?.subtype !== "success") failed = true;
    } catch (err) {
      console.error(`[${name}] run threw:`, err);
      failed = true;
    }
  }
  process.exit(failed ? 1 : 0);
}

void main();
