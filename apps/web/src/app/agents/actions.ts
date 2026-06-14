"use server";

import {
  findRepoRoot,
  listRuns,
  resolveTarget,
  runInProgress,
} from "@localfinds/db";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { revalidatePath } from "next/cache";

// How long to wait for the spawned CLI to register its `running` row before
// returning. The loop breaks as soon as the row appears, so this only caps the
// wait when a run is slow to start (`npx tsx` cold start + SDK init was ~10s in
// testing) — generous margin here costs nothing in the normal case but ensures
// the re-rendered page shows the running state and mounts the live transcript.
const START_TIMEOUT_MS = 20_000;
const POLL_MS = 250;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// `triggerRun` is used as a form action via `triggerRun.bind(null, target)`, so
// the bound target comes first and the form's FormData second (unused).
export async function triggerRun(target: string): Promise<void> {
  const resolved = resolveTarget(target);
  if (!resolved) return;

  // Concurrency guard — agents share the DB and profiles and the roster is
  // sequential, so refuse to start while a live run is in progress.
  if (runInProgress(listRuns(50), Date.now())) return;

  const repoRoot = findRepoRoot();
  const logPath = path.join(repoRoot, "data", "agents", "web.log");
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logFd = fs.openSync(logPath, "a");
  fs.writeSync(
    logFd,
    `\n=== web-trigger ${resolved} ${new Date().toISOString()} ===\n`,
  );

  // Detached + unref so the run outlives this request. The CLI records the run
  // (startRun/finishRun), so no run-tracking happens here.
  const child = spawn("npx", ["tsx", "packages/agents/src/cli.ts", resolved], {
    cwd: repoRoot,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });
  child.unref();
  fs.closeSync(logFd);

  // Wait until the child's `running` row appears so the re-rendered page shows
  // it (and the live transcript panel takes over from there).
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (runInProgress(listRuns(20), Date.now())) break;
    await sleep(POLL_MS);
  }

  revalidatePath("/agents");
}
