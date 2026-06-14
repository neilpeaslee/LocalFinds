#!/usr/bin/env node
// Fetch real municipal boundary polygons for the dashboard map's coverage layer.
//
// Reads the town list from data/config/towns.json and the state from
// data/config/region.md, asks Nominatim for each town's administrative boundary
// as GeoJSON, and writes a FeatureCollection to data/config/town-boundaries.json
// (+ .example). Re-run whenever you change the town list or move regions.
//
// One-time / occasional use — respects Nominatim's 1 req/sec policy. No key.
//
//   node scripts/fetch-town-boundaries.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configDir = path.join(root, "data", "config");
const townsPath = path.join(configDir, "towns.json");
const regionPath = path.join(configDir, "region.md");
const outPath = path.join(configDir, "town-boundaries.json");
const examplePath = `${outPath}.example`;

const UA =
  "LocalFinds/1.0 (local-discovery dashboard; one-time boundary fetch; contact npeaslee@gmail.com)";
const NOMINATIM = "https://nominatim.openstreetmap.org/search";

function readState() {
  // region.md frontmatter: name: "Town, State" — take the part after the comma.
  try {
    const raw = fs.readFileSync(regionPath, "utf8");
    const m = raw.match(/^name:\s*(.+)$/m);
    const name = m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
    const parts = name.split(",").map((s) => s.trim());
    if (parts.length >= 2 && parts[1]) return parts[1];
  } catch {
    /* fall through */
  }
  return "Maine";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Does a representative point fall within (a slightly padded) town bbox?
// This is how we reject the wrong "Rockland" (ME ~44.1 vs MA ~42.1).
function inBbox(lat, lon, [s, w, n, e]) {
  const pad = 0.03;
  return lat >= s - pad && lat <= n + pad && lon >= w - pad && lon <= e + pad;
}

async function fetchBoundary(town, state) {
  // County context disambiguates collisions (Washington/Union/Hope exist in many
  // states); an optional `query` override handles odd names (e.g. plantations).
  const where = town.county ? `${town.county}, ${state}` : state;
  const params = new URLSearchParams({
    q: `${town.query ?? town.name}, ${where}`,
    format: "json",
    polygon_geojson: "1",
    polygon_threshold: "0.0004", // ~40m simplification — keeps shape, trims size
    countrycodes: "us",
    limit: "5",
  });
  const res = await fetch(`${NOMINATIM}?${params}`, {
    headers: { "User-Agent": UA },
  });
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status} for ${town.name}`);
  const results = await res.json();

  // Prefer an administrative boundary inside the town bbox; fall back to any
  // boundary, then any polygon, that lands in the bbox.
  const candidates = results.filter(
    (r) =>
      r.geojson &&
      (r.geojson.type === "Polygon" || r.geojson.type === "MultiPolygon") &&
      inBbox(Number(r.lat), Number(r.lon), town.bbox),
  );
  const pick =
    candidates.find((r) => r.class === "boundary" && r.type === "administrative") ??
    candidates.find((r) => r.class === "boundary") ??
    candidates[0];

  if (!pick) return null;
  return {
    type: "Feature",
    properties: {
      name: town.name,
      primary: Boolean(town.primary),
      osm: `${pick.osm_type}/${pick.osm_id}`,
    },
    geometry: pick.geojson,
  };
}

async function main() {
  const towns = JSON.parse(fs.readFileSync(townsPath, "utf8")).towns ?? [];
  const state = readState();
  console.log(`Fetching ${towns.length} town boundaries in ${state}…`);

  const features = [];
  const missing = [];
  for (const town of towns) {
    try {
      const feature = await fetchBoundary(town, state);
      if (feature) {
        features.push(feature);
        console.log(`  ✓ ${town.name} (${feature.properties.osm})`);
      } else {
        missing.push(town.name);
        console.log(`  ✗ ${town.name} — no boundary in bbox (will fall back to box)`);
      }
    } catch (err) {
      missing.push(town.name);
      console.log(`  ! ${town.name} — ${err.message}`);
    }
    await sleep(1100); // Nominatim: max 1 req/sec
  }

  const fc = { type: "FeatureCollection", features };
  const json = `${JSON.stringify(fc, null, 0)}\n`;
  fs.writeFileSync(outPath, json);
  fs.writeFileSync(examplePath, json);
  console.log(
    `\nWrote ${features.length} boundaries to ${path.relative(root, outPath)} (+ .example).` +
      (missing.length ? ` Missing: ${missing.join(", ")}.` : ""),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
