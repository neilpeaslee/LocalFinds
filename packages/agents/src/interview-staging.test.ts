import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createStagingDir,
  seedStaging,
  promoteStaging,
  discardStaging,
} from "./interview-staging";

function realDirWith(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lf-real-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return root;
}

describe("interview staging", () => {
  it("creates a mirrored staging dir and seeds existing config", () => {
    const real = realDirWith({
      "config/region.md": "REGION",
      "config/towns.json": "{}",
      "agents/prospector/profile.md": "OLD ICP",
    });
    const staging = createStagingDir(real, "run1");
    expect(staging).toBe(path.join(real, ".staging-run1"));

    seedStaging(real, staging);
    expect(fs.readFileSync(path.join(staging, "config/region.md"), "utf8")).toBe("REGION");
    expect(fs.readFileSync(path.join(staging, "agents/prospector/profile.md"), "utf8")).toBe("OLD ICP");
    // categories.json didn't exist in real → not seeded, no throw.
    expect(fs.existsSync(path.join(staging, "config/categories.json"))).toBe(false);
  });

  it("promotes staged artifacts over the real ones and discards cleanly", () => {
    const real = realDirWith({ "config/region.md": "OLD" });
    const staging = createStagingDir(real, "run2");
    fs.mkdirSync(path.join(staging, "config"), { recursive: true });
    fs.mkdirSync(path.join(staging, "agents/prospector"), { recursive: true });
    fs.writeFileSync(path.join(staging, "config/region.md"), "NEW");
    fs.writeFileSync(path.join(staging, "agents/prospector/profile.md"), "NEW ICP");

    const written = promoteStaging(real, staging);
    expect(fs.readFileSync(path.join(real, "config/region.md"), "utf8")).toBe("NEW");
    expect(fs.readFileSync(path.join(real, "agents/prospector/profile.md"), "utf8")).toBe("NEW ICP");
    expect(written).toContain(path.join(real, "config/region.md"));

    discardStaging(staging);
    expect(fs.existsSync(staging)).toBe(false);
  });
});
