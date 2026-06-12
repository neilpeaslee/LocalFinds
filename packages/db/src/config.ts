import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./paths";

export interface RegionConfig {
  name: string;
  /** Full file contents — injected verbatim into agent prompts. */
  raw: string;
}

export function regionConfigPath(): string {
  return path.join(dataDir(), "config", "region.md");
}

export function readRegionConfig(): RegionConfig | null {
  const file = regionConfigPath();
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, "utf8");
  let name = "Unnamed region";
  const frontmatter = raw.match(/^---\n([\s\S]*?)\n---/);
  const nameLine = frontmatter?.[1].match(/^name:\s*(.+)$/m);
  if (nameLine) name = nameLine[1].trim().replace(/^["']|["']$/g, "");
  return { name, raw };
}
