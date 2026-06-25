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

// The repo root never moves within a process, so cache the walk — it was
// previously re-run (existsSync + read + parse per level) on every call,
// including once per row when a page reads agent notes in a render loop.
let repoDataDirCache: string | undefined;

export function dataDir(): string {
  if (process.env.LOCALFINDS_DATA_DIR) return process.env.LOCALFINDS_DATA_DIR;
  if (!repoDataDirCache) repoDataDirCache = path.join(findRepoRoot(), "data");
  return repoDataDirCache;
}

// An optional override used by the interviewer to stage config + ICP writes in a
// scratch directory until the user confirms. It deliberately does NOT affect
// dbPath() or agentWorkspaceDir — leads still go to the real DB and agent run
// logs to the real workspace. Single-threaded, sequential use only.
let configDirOverride: string | undefined;

export function setConfigDirOverride(dir: string | undefined): void {
  configDirOverride = dir;
}

export function configDir(): string {
  return configDirOverride ?? dataDir();
}

export function dbPath(): string {
  return path.join(dataDir(), "localfinds.db");
}

export function agentWorkspaceDir(agent: string): string {
  return path.join(dataDir(), "agents", agent);
}

// Read a workspace-relative note for an agent, refusing any path that escapes
// the agent's workspace. Shared by the /businesses and /sources pages so the
// path-traversal guard lives in exactly one place.
export function readAgentNote(
  agent: string,
  notesPath: string | null | undefined,
): string | null {
  if (!notesPath) return null;
  const workspace = agentWorkspaceDir(agent);
  const resolved = path.resolve(workspace, notesPath);
  if (resolved !== workspace && !resolved.startsWith(workspace + path.sep)) {
    return null;
  }
  try {
    return fs.readFileSync(resolved, "utf8");
  } catch {
    return null;
  }
}
