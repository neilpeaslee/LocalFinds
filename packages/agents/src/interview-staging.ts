// Staging for the interview cycle: build writes config + ICP here, the sample
// run reads from here, and only on the user's final confirm do we promote these
// four artifacts over the real ones. A reject is a plain rm -rf — the live config
// is never touched mid-interview, so a crash can't corrupt it.

import fs from "node:fs";
import path from "node:path";

// The four interviewer-written artifacts, as paths relative to the data dir.
const STAGED_ARTIFACTS = [
  "config/region.md",
  "config/towns.json",
  "config/categories.json",
  "agents/prospector/profile.md",
];

export function createStagingDir(realDataDir: string, runId: string): string {
  const staging = path.join(realDataDir, `.staging-${runId}`);
  fs.mkdirSync(path.join(staging, "config"), { recursive: true });
  fs.mkdirSync(path.join(staging, "agents", "prospector", "notes"), { recursive: true });
  return staging;
}

export function seedStaging(realDataDir: string, stagingDir: string): void {
  for (const rel of STAGED_ARTIFACTS) {
    const src = path.join(realDataDir, rel);
    if (!fs.existsSync(src)) continue; // cold start — nothing to seed
    const dest = path.join(stagingDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

export function promoteStaging(realDataDir: string, stagingDir: string): string[] {
  const written: string[] = [];
  for (const rel of STAGED_ARTIFACTS) {
    const src = path.join(stagingDir, rel);
    if (!fs.existsSync(src)) continue; // build didn't write this one
    const dest = path.join(realDataDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    written.push(dest);
  }
  return written;
}

export function discardStaging(stagingDir: string): void {
  fs.rmSync(stagingDir, { recursive: true, force: true });
}
