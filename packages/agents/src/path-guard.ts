import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import path from "node:path";
import { hostOf } from "./web-fetch-log";

// cwd scopes the default directory but built-in file tools accept absolute
// paths — this PreToolUse hook is the actual sandbox boundary.
export function makePathGuard(workspaceDir: string): HookCallback {
  const root = path.resolve(workspaceDir);

  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
    const candidates = ["file_path", "path", "notebook_path"]
      .map((key) => toolInput[key])
      .filter((value): value is string => typeof value === "string");

    for (const candidate of candidates) {
      const resolved = path.resolve(root, candidate);
      if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse" as const,
            permissionDecision: "deny" as const,
            permissionDecisionReason: `Path is outside your workspace (${root}); work only within it: ${candidate}`,
          },
        };
      }
    }
    return {};
  };
}

// PreToolUse hook for WebFetch: deny fetches to hosts on the blocklist (computed
// from the fetches table). Model-independent backstop for the prompt's
// "hosts to skip" note. Fails open on a URL we can't parse — WebFetch will
// reject a malformed URL on its own; the guard's only job is the blocklist.
export function makeWebFetchGuard(blocked: Set<string>): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
    const url = toolInput.url;
    if (typeof url !== "string") return {};
    const host = hostOf(url);
    if (host && blocked.has(host)) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse" as const,
          permissionDecision: "deny" as const,
          permissionDecisionReason: `Host ${host} returned 403/401 on the last several runs — skip it; do not fetch this URL.`,
        },
      };
    }
    return {};
  };
}
