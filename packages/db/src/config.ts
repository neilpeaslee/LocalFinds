import fs from "node:fs";
import path from "node:path";
import { configDir, dataDir } from "./paths";

export interface RegionConfig {
  name: string;
  /** Full file contents — injected verbatim into agent prompts. */
  raw: string;
}

export function regionConfigPath(): string {
  return path.join(configDir(), "config", "region.md");
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

// Write region.md from a structured shape — frontmatter `name:` plus the
// coverage prose. Round-validates by reading the name back through
// readRegionConfig, the same parser the agents use, so a write that wouldn't
// parse is a throw, never a silently broken file. The name is JSON-quoted so a
// value containing a comma (e.g. "Rockland, Maine") survives the frontmatter.
export function writeRegionConfig(input: {
  name: string;
  coverageMarkdown: string;
}): void {
  const body = input.coverageMarkdown.trim();
  const contents = `---\nname: ${JSON.stringify(input.name)}\n---\n\n${body}\n`;
  fs.mkdirSync(path.dirname(regionConfigPath()), { recursive: true });
  fs.writeFileSync(regionConfigPath(), contents);
  const check = readRegionConfig();
  if (!check || check.name !== input.name) {
    throw new Error(
      `writeRegionConfig: name did not round-trip through readRegionConfig (${input.name})`,
    );
  }
}

// --- Category search-priority config (data/config/categories.json) ---

export interface CategoryConfig {
  /** Tier for a business category (kind) not listed in any tier. */
  defaultTier: number;
  /** Whether the /places page hides these by default. */
  hideInDirectory: { tier4: boolean; chains: boolean };
  /** Raw tier → categories map, for display and prompt injection. */
  tiers: Record<string, string[]>;
  /** Tier (1 = highest) for an OSM "key=value" kind, applying wildcards + default. */
  tierOf(kind: string | null | undefined): number;
}

export function categoryConfigPath(): string {
  return path.join(configDir(), "config", "categories.json");
}

// Reads categories.json, falling back to the .example template, then to a
// permissive default (everything at default_tier) so the app never breaks.
// A present-but-malformed file must NOT silently wipe the tier ranking — it
// falls through to the next candidate (the committed template).
export function readCategoryConfig(): CategoryConfig {
  const file = categoryConfigPath();
  let parsed: {
    default_tier?: number;
    hide_in_directory?: { tier4?: boolean; chains?: boolean };
    tiers?: Record<string, string[]>;
  } = {};
  for (const candidate of [file, `${file}.example`]) {
    let raw: string;
    try {
      raw = fs.readFileSync(candidate, "utf8");
    } catch {
      continue; // missing file — try the next candidate
    }
    try {
      const json = JSON.parse(raw);
      if (json && typeof json === "object") {
        parsed = json;
        break; // accepted a well-formed candidate
      }
    } catch {
      // malformed JSON — fall through to the next candidate, don't accept it
    }
  }

  // Coerce numbers defensively so a hand-edited string never becomes NaN.
  const toTier = (value: unknown, fallback: number): number => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };

  const defaultTier = toTier(parsed.default_tier, 3);
  const tiers = parsed.tiers ?? {};
  const hideInDirectory = {
    tier4: parsed.hide_in_directory?.tier4 ?? true,
    chains: parsed.hide_in_directory?.chains ?? true,
  };

  const exact = new Map<string, number>();
  const wild = new Map<string, number>(); // "amenity" -> tier (from "amenity=*")
  for (const [tierStr, cats] of Object.entries(tiers)) {
    const tier = Number(tierStr);
    if (!Number.isFinite(tier)) continue; // skip a non-numeric tier key
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

// An OSM "key=value" kind, or a "key=*" wildcard. The key side is permissive
// (whatever real OSM keys appear in the live config) but a single `=` and a
// non-empty value are required, so a bare word or empty entry is rejected
// rather than written into a file the prospector and /places page read.
const CATEGORY_RE = /^[a-z_]+=(?:\*|[a-z0-9_:.-]+)$/;

// Write categories.json from the same shape readCategoryConfig consumes (the
// snake_case on-disk keys, not the camelCase reader output). Every category is
// validated against CATEGORY_RE first — a writer that can't faithfully rewrite
// the config already shipping is the worst failure mode, so the round-trip test
// validates this against every live entry.
export function writeCategoryConfig(
  input: {
    default_tier: number;
    hide_in_directory: { tier4: boolean; chains: boolean };
    tiers: Record<string, string[]>;
  },
  opts: { comment?: string } = {},
): void {
  for (const [tier, cats] of Object.entries(input.tiers)) {
    if (!Number.isFinite(Number(tier))) {
      throw new Error(`writeCategoryConfig: non-numeric tier key "${tier}"`);
    }
    for (const cat of cats) {
      if (!CATEGORY_RE.test(cat)) {
        throw new Error(
          `writeCategoryConfig: "${cat}" is not an OSM key=value (or key=*) category`,
        );
      }
    }
  }
  const payload: Record<string, unknown> = {};
  if (opts.comment) payload._comment = opts.comment;
  payload.default_tier = input.default_tier;
  payload.hide_in_directory = input.hide_in_directory;
  payload.tiers = input.tiers;
  fs.mkdirSync(path.dirname(categoryConfigPath()), { recursive: true });
  fs.writeFileSync(categoryConfigPath(), `${JSON.stringify(payload, null, 2)}\n`);
}

// --- Town coverage boxes (data/config/towns.json) ---

export interface TownBox {
  name: string;
  /** Overpass bbox order: [south, west, north, east] = [minLat, minLng, maxLat, maxLng]. */
  bbox: [number, number, number, number];
  /** The home town, highlighted on the map. */
  primary?: boolean;
}

export interface TownsConfig {
  towns: TownBox[];
}

export function townsConfigPath(): string {
  return path.join(configDir(), "config", "towns.json");
}

function isValidTownBox(t: unknown): t is TownBox {
  const box = t as TownBox;
  return (
    !!box &&
    typeof box.name === "string" &&
    Array.isArray(box.bbox) &&
    box.bbox.length === 4 &&
    box.bbox.every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

// Reads towns.json, falling back to the committed .example, then to an empty
// list so the dashboard map never breaks. A present-but-malformed file falls
// through to the next candidate rather than silently wiping the coverage boxes.
export function readTownsConfig(): TownsConfig {
  const file = townsConfigPath();
  for (const candidate of [file, `${file}.example`]) {
    let raw: string;
    try {
      raw = fs.readFileSync(candidate, "utf8");
    } catch {
      continue; // missing file — try the next candidate
    }
    try {
      const json = JSON.parse(raw);
      const towns = Array.isArray(json?.towns)
        ? (json.towns as unknown[]).filter(isValidTownBox)
        : [];
      return { towns }; // accepted a well-formed candidate
    } catch {
      // malformed JSON — fall through to the next candidate, don't accept it
    }
  }
  return { towns: [] };
}

// A town as written by the interviewer: the map-facing {name, bbox, primary}
// plus the disambiguation hints fetch-town-boundaries.mjs needs (county,
// optional query). The reader (readTownsConfig) only types name/bbox/primary
// but the on-disk objects carry county/query verbatim, so the writer must too.
export interface WritableTown extends TownBox {
  county?: string;
  query?: string;
}

// Write towns.json, throwing on any town whose bbox fails isValidTownBox — a bad
// box surfaces loudly instead of being silently dropped (the data-safety rule,
// since town-boundaries.json polygons are matched to these exact bboxes). All
// towns are validated before anything is written, so a bad batch leaves the
// existing file untouched. county/query/primary are preserved; an optional
// `_comment` is round-tripped so the file's human notes aren't wiped.
export function writeTownsConfig(
  towns: WritableTown[],
  opts: { comment?: string } = {},
): void {
  for (const t of towns) {
    if (!isValidTownBox(t)) {
      const label =
        t && typeof (t as { name?: unknown }).name === "string"
          ? (t as { name: string }).name
          : JSON.stringify(t);
      throw new Error(`writeTownsConfig: invalid town box for ${label}`);
    }
  }
  const payload: Record<string, unknown> = {};
  if (opts.comment) payload._comment = opts.comment;
  payload.towns = towns.map((t) => {
    const out: Record<string, unknown> = { name: t.name };
    if (t.county !== undefined) out.county = t.county;
    if (t.query !== undefined) out.query = t.query;
    out.bbox = t.bbox;
    if (t.primary) out.primary = true;
    return out;
  });
  fs.mkdirSync(path.dirname(townsConfigPath()), { recursive: true });
  fs.writeFileSync(townsConfigPath(), `${JSON.stringify(payload, null, 2)}\n`);
}

// --- Prospector ICP profile (data/agents/prospector/profile.md) ---
//
// The interviewer is the only writer of the prospector's ICP; until it runs the
// file is byte-identical to the committed template and the prospector has
// nothing to match. These helpers live here (not in run-agent) so config tests
// can round-trip them with the other config writers.

export function icpProfilePath(): string {
  return path.join(configDir(), "agents", "prospector", "profile.md");
}

// Write the prospector's ICP, creating its workspace + notes/ first (the same
// layout ensureWorkspace builds) so a cold machine doesn't need a prior run.
export function writeIcpProfile(markdown: string): void {
  const workspace = path.join(configDir(), "agents", "prospector");
  fs.mkdirSync(path.join(workspace, "notes"), { recursive: true });
  fs.writeFileSync(icpProfilePath(), markdown);
}

// Current ICP, or null if it's still untouched. "Untouched" = missing, or
// byte-identical to profile.md.example — the prospector seeds profile.md by
// copying the .example, so a cold profile reads exactly equal to it. We do NOT
// sniff for "(e.g" substrings: those appear in legitimate ICP prose.
export function readIcpProfile(): string | null {
  const file = icpProfilePath();
  let current: string;
  try {
    current = fs.readFileSync(file, "utf8");
  } catch {
    return null; // no profile written yet
  }
  try {
    const example = fs.readFileSync(`${file}.example`, "utf8");
    if (current === example) return null; // copied template, never edited
  } catch {
    // no template to compare against — treat any present profile as real
  }
  return current;
}

// --- Town boundary polygons (data/config/town-boundaries.json) ---
//
// Real municipal outlines (GeoJSON) for the dashboard map's coverage layer,
// produced by scripts/fetch-town-boundaries.mjs. Geometry is GeoJSON order
// ([lng, lat]); the map swaps to Leaflet's [lat, lng] when drawing.

export interface TownBoundaryFeature {
  type: "Feature";
  properties: { name: string; primary?: boolean; osm?: string };
  geometry: {
    type: "Polygon" | "MultiPolygon";
    // Polygon: ring[]; MultiPolygon: polygon[] of ring[]. Rings are [lng, lat].
    coordinates: number[][][] | number[][][][];
  };
}

export interface TownBoundaries {
  type: "FeatureCollection";
  features: TownBoundaryFeature[];
}

export function townBoundariesPath(): string {
  return path.join(dataDir(), "config", "town-boundaries.json");
}

// Reads town-boundaries.json, falling back to the committed .example, then to an
// empty collection. The map degrades to bbox rectangles for any town without a
// polygon, so a missing/malformed file never breaks the dashboard.
export function readTownBoundaries(): TownBoundaries {
  const file = townBoundariesPath();
  for (const candidate of [file, `${file}.example`]) {
    let raw: string;
    try {
      raw = fs.readFileSync(candidate, "utf8");
    } catch {
      continue; // missing file — try the next candidate
    }
    try {
      const json = JSON.parse(raw);
      const features = Array.isArray(json?.features)
        ? (json.features as TownBoundaryFeature[]).filter(
            (f) =>
              f?.geometry &&
              Array.isArray(f.geometry.coordinates) &&
              typeof f.properties?.name === "string",
          )
        : [];
      return { type: "FeatureCollection", features };
    } catch {
      // malformed JSON — fall through to the next candidate
    }
  }
  return { type: "FeatureCollection", features: [] };
}

// --- Map theme config (data/config/map-categories.json) ---
//
// Colors + groups OSM `kind`s into display themes for the region map's legend
// and pin colors. Render-time only (like categories.json tiers) — NOT a schema
// column, honoring "no content taxonomy in the DB".

export interface MapTheme {
  key: string;
  label: string;
  color: string;
  /** OSM "key=value" -> friendly sub-type label. "key=*" is a wildcard. */
  subtypes: Record<string, string>;
}

export interface ThemeMatch {
  key: string;
  label: string;
  color: string;
  /** Friendly sub-type label, or null when unmatched. */
  subtype: string | null;
  /** The config key matched (e.g. "shop=*" or "leisure=park"); null = Other. */
  subtypeKey: string | null;
}

export interface MapCategoryConfig {
  themes: MapTheme[];
  otherKey: string;
  otherLabel: string;
  otherColor: string;
  /** Resolve an OSM kind to its theme + sub-type (exact, then key=* wildcard, then Other). */
  themeOf(kind: string | null | undefined): ThemeMatch;
}

export function mapCategoriesPath(): string {
  return path.join(dataDir(), "config", "map-categories.json");
}

// Reads map-categories.json, falling back to the .example template, then to a
// permissive default (empty themes → everything resolves to "Other") so the map
// never breaks. A present-but-malformed file falls through to the next candidate.
export function readMapCategories(): MapCategoryConfig {
  const file = mapCategoriesPath();
  let parsed: {
    themes?: MapTheme[];
    otherKey?: string;
    otherLabel?: string;
    otherColor?: string;
  } = {};
  for (const candidate of [file, `${file}.example`]) {
    let raw: string;
    try {
      raw = fs.readFileSync(candidate, "utf8");
    } catch {
      continue; // missing — try the next candidate
    }
    try {
      const json = JSON.parse(raw);
      if (json && typeof json === "object") {
        parsed = json;
        break; // accepted a well-formed candidate
      }
    } catch {
      // malformed JSON — fall through to the next candidate
    }
  }

  const themes = Array.isArray(parsed.themes) ? parsed.themes : [];
  const otherKey = parsed.otherKey ?? "other";
  const otherLabel = parsed.otherLabel ?? "Other";
  const otherColor = parsed.otherColor ?? "#64748b";

  // Build exact + wildcard lookups once. If the same key appears in two themes,
  // the first theme listed in the array wins.
  const exact = new Map<string, { theme: MapTheme; label: string }>();
  const wild = new Map<string, { theme: MapTheme; label: string }>(); // "shop" -> ...
  for (const theme of themes) {
    for (const [k, label] of Object.entries(theme.subtypes ?? {})) {
      if (k.endsWith("=*")) {
        const key = k.slice(0, -2);
        if (!wild.has(key)) wild.set(key, { theme, label });
      } else if (!exact.has(k)) {
        exact.set(k, { theme, label });
      }
    }
  }

  const other: ThemeMatch = {
    key: otherKey, label: otherLabel, color: otherColor, subtype: null, subtypeKey: null,
  };

  const themeOf = (kind: string | null | undefined): ThemeMatch => {
    if (!kind) return other;
    const e = exact.get(kind);
    if (e) {
      return { key: e.theme.key, label: e.theme.label, color: e.theme.color,
        subtype: e.label, subtypeKey: kind };
    }
    const osmKey = kind.split("=")[0];
    const w = wild.get(osmKey);
    if (w) {
      return { key: w.theme.key, label: w.theme.label, color: w.theme.color,
        subtype: w.label, subtypeKey: `${osmKey}=*` };
    }
    return other;
  };

  return { themes, otherKey, otherLabel, otherColor, themeOf };
}

// A readable tier listing for injection into agent prompts.
export function formatCategoryPriorities(cfg: CategoryConfig): string {
  const lines = Object.keys(cfg.tiers)
    .sort((a, b) => Number(a) - Number(b))
    .map((t) => {
      const label = t === "4" ? `Tier ${t} (SKIP — not businesses)` : `Tier ${t}`;
      return `- ${label}: ${cfg.tiers[t].join(", ")}`;
    });
  return [
    `Categories not listed default to Tier ${cfg.defaultTier}. National/regional chains (OSM brand tag) are lowest priority regardless of tier.`,
    ...lines,
  ].join("\n");
}

// --- Agent runtime config (data/config/agents.json) ---
// App-manageable knobs for agent runs — currently just the per-run budget cap. A
// future app-settings UI edits data/config/agents.json (a real file overrides the
// committed .example). Run-time only, NOT schema. A malformed source falls through
// to the next one so an unattended cron run never dies on a bad settings edit.
export interface AgentsConfig {
  maxBudgetUsd: number;
}

export function agentsConfigPath(): string {
  return path.join(dataDir(), "config", "agents.json");
}

// Parse one source; null on malformed/invalid so the caller can try the next
// (real agents.json -> .example -> built-in default).
export function tryParseAgentsConfig(text: string): AgentsConfig | null {
  try {
    const n = Number((JSON.parse(text) as { maxBudgetUsd?: unknown })?.maxBudgetUsd);
    if (Number.isFinite(n) && n > 0) return { maxBudgetUsd: n };
  } catch {
    // fall through
  }
  return null;
}

export function readAgentsConfig(): AgentsConfig {
  for (const file of [agentsConfigPath(), `${agentsConfigPath()}.example`]) {
    try {
      const cfg = tryParseAgentsConfig(fs.readFileSync(file, "utf8"));
      if (cfg) return cfg;
    } catch {
      // missing / unreadable / not a file — try the next source
    }
  }
  return { maxBudgetUsd: 1.0 };
}
