import { findRepoRoot } from "@localfinds/db";
import fs from "node:fs";
import path from "node:path";

// Minimal .env loader (KEY=VALUE lines) — real env vars take precedence.
export function loadEnv(): void {
  const file = path.join(findRepoRoot(), ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || line.trim().startsWith("#")) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^["']|["']$/g, "");
  }
}
