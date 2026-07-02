import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureWorkspace, statusFromResult, workspaceSystemNote, effectiveMaxBudgetUsd, type AgentDefinition, type RunOptions } from "./run-agent";

describe("ensureWorkspace(dir)", () => {
  it("creates notes/ and seeds a profile.md at the GIVEN dir", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lf-ws-"));
    const out = ensureWorkspace(dir);
    expect(out).toBe(dir);
    expect(fs.existsSync(path.join(dir, "notes"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "profile.md"))).toBe(true);
  });

  it("does not clobber an existing profile.md", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lf-ws-"));
    fs.writeFileSync(path.join(dir, "profile.md"), "# Mine\n");
    ensureWorkspace(dir);
    expect(fs.readFileSync(path.join(dir, "profile.md"), "utf8")).toBe("# Mine\n");
  });
});

describe("statusFromResult", () => {
  const result = (subtype: string) => ({ subtype }) as never;

  it("maps a clean finish to success", () => {
    expect(statusFromResult(result("success"))).toBe("success");
  });

  it("maps a budget cap to capped, not error (it's the intended guardrail)", () => {
    expect(statusFromResult(result("error_max_budget_usd"))).toBe("capped");
  });

  it("maps other non-success subtypes to error", () => {
    expect(statusFromResult(result("error_max_turns"))).toBe("error");
    expect(statusFromResult(result("error_during_execution"))).toBe("error");
  });

  it("treats a missing result as error", () => {
    expect(statusFromResult(undefined)).toBe("error");
  });
});

describe("workspaceSystemNote", () => {
  const workspace = "/home/neil/Projects/LocalFinds/data/agents/scout";

  it("tells the agent its absolute workspace directory", () => {
    expect(workspaceSystemNote(workspace)).toContain(workspace);
  });

  it("anchors profile.md and notes/ to the absolute workspace path", () => {
    const note = workspaceSystemNote(workspace);
    // The file tools require absolute paths, so the agent must be handed the
    // real prefix for its own files — otherwise it guesses (see runs 14/20).
    expect(note).toContain(`${workspace}/profile.md`);
    expect(note).toContain(`${workspace}/notes`);
  });

  it("warns against the root-anchored paths the agents actually tried", () => {
    // Cartographer used /notes/coverage.md; scout used /workspace/notes/...,
    // both denied. The note must steer the model off those forms.
    const note = workspaceSystemNote(workspace);
    expect(note).toContain("/notes/");
    expect(note).toContain("/workspace/");
  });
});

describe("effectiveMaxBudgetUsd", () => {
  const def = { defaultMaxBudgetUsd: 2.0 } as AgentDefinition;
  const bare = {} as AgentDefinition;

  it("prefers the CLI option, then the agent default, then 1.0", () => {
    expect(effectiveMaxBudgetUsd(def, { maxBudgetUsd: 0.5 } as RunOptions)).toBe(0.5);
    expect(effectiveMaxBudgetUsd(def, {} as RunOptions)).toBe(2.0);
    expect(effectiveMaxBudgetUsd(bare, {} as RunOptions)).toBe(1.0);
  });
});
