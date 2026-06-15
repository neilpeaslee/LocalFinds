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
  return path.join(dataDir(), "config", "towns.json");
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
