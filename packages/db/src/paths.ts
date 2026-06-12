import fs from "node:fs";
import path from "node:path";

// Web app runs with cwd=apps/web, agents with cwd=packages/agents — walk up
// to the workspace root so both find the same data directory.
export function findRepoRoot(start: string = process.cwd()): string {
  let dir = path.resolve(start);
  for (;;) {
    const pkg = path.join(dir, "package.json");
    if (fs.existsSync(pkg)) {
      try {
        if (JSON.parse(fs.readFileSync(pkg, "utf8")).name === "localfinds") {
          return dir;
        }
      } catch {
        // unreadable package.json — keep walking
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
}

export function dataDir(): string {
  return process.env.LOCALFINDS_DATA_DIR ?? path.join(findRepoRoot(), "data");
}

export function dbPath(): string {
  return path.join(dataDir(), "localfinds.db");
}

export function agentWorkspaceDir(agent: string): string {
  return path.join(dataDir(), "agents", agent);
}
