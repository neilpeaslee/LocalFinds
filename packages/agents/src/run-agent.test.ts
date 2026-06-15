import { describe, expect, it } from "vitest";
import { workspaceSystemNote } from "./run-agent";

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
