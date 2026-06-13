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

// --- Category search-priority config (data/config/categories.json) ---

export interface CategoryConfig {
  /** Tier for a business category (kind) not listed in any tier. */
  defaultTier: number;
  /** Whether the /businesses page hides these by default. */
  hideInDirectory: { tier4: boolean; chains: boolean };
  /** Raw tier → categories map, for display and prompt injection. */
  tiers: Record<string, string[]>;
  /** Tier (1 = highest) for an OSM "key=value" kind, applying wildcards + default. */
  tierOf(kind: string | null | undefined): number;
}

export function categoryConfigPath(): string {
  return path.join(dataDir(), "config", "categories.json");
}

// Reads categories.json, falling back to the .example template, then to a
// permissive default (everything at default_tier) so the app never breaks.
export function readCategoryConfig(): CategoryConfig {
  const file = categoryConfigPath();
  let raw = "";
  for (const candidate of [file, `${file}.example`]) {
    try {
      raw = fs.readFileSync(candidate, "utf8");
      break;
    } catch {
      // try next
    }
  }
  let parsed: {
    default_tier?: number;
    hide_in_directory?: { tier4?: boolean; chains?: boolean };
    tiers?: Record<string, string[]>;
  } = {};
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = {};
    }
  }

  const defaultTier = Number(parsed.default_tier ?? 3);
  const tiers = parsed.tiers ?? {};
  const hideInDirectory = {
    tier4: parsed.hide_in_directory?.tier4 ?? true,
    chains: parsed.hide_in_directory?.chains ?? true,
  };

  const exact = new Map<string, number>();
  const wild = new Map<string, number>(); // "amenity" -> tier (from "amenity=*")
  for (const [tierStr, cats] of Object.entries(tiers)) {
    const tier = Number(tierStr);
    for (const cat of cats) {
      if (cat.endsWith("=*")) wild.set(cat.slice(0, -2), tier);
      else exact.set(cat, tier);
    }
  }

  const tierOf = (kind: string | null | undefined): number => {
    if (!kind) return defaultTier;
    const e = exact.get(kind);
    if (e !== undefined) return e;
    const key = kind.split("=")[0];
    const w = wild.get(key);
    if (w !== undefined) return w;
    return defaultTier;
  };

  return { defaultTier, hideInDirectory, tiers, tierOf };
}

// A readable tier listing for injection into agent prompts.
export function formatCategoryPriorities(cfg: CategoryConfig): string {
  const lines = Object.keys(cfg.tiers)
    .sort()
    .map((t) => {
      const label = t === "4" ? `Tier ${t} (SKIP — not businesses)` : `Tier ${t}`;
      return `- ${label}: ${cfg.tiers[t].join(", ")}`;
    });
  return [
    `Categories not listed default to Tier ${cfg.defaultTier}. National/regional chains (OSM brand tag) are lowest priority regardless of tier.`,
    ...lines,
  ].join("\n");
}
