import type { PreToolUseHookSpecificOutput, SyncHookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { makeWebFetchGuard } from "./path-guard";

const call = async (guard: ReturnType<typeof makeWebFetchGuard>, url: unknown) =>
  (await guard(
    { hook_event_name: "PreToolUse", tool_input: { url } } as never,
    undefined as never,
    undefined as never,
  )) as SyncHookJSONOutput;

describe("makeWebFetchGuard", () => {
  it("denies a fetch to a blocked host", async () => {
    const out = await call(makeWebFetchGuard(new Set(["owlshead.org"])), "https://owlshead.org/events/");
    const specific = out.hookSpecificOutput as PreToolUseHookSpecificOutput | undefined;
    expect(specific?.permissionDecision).toBe("deny");
  });

  it("allows a fetch to a non-blocked host", async () => {
    const out = await call(makeWebFetchGuard(new Set(["owlshead.org"])), "https://merryspring.org/calendar/");
    expect(out).toEqual({});
  });

  it("fails open on an unparseable url", async () => {
    const out = await call(makeWebFetchGuard(new Set(["owlshead.org"])), "not a url");
    expect(out).toEqual({});
  });

  it("ignores non-PreToolUse events", async () => {
    const guard = makeWebFetchGuard(new Set(["owlshead.org"]));
    const out = await guard({ hook_event_name: "PostToolUse" } as never, undefined as never, undefined as never);
    expect(out).toEqual({});
  });
});
