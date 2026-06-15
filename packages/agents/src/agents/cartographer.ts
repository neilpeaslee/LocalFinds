import type { AgentDefinition } from "../run-agent";

export const cartographer: AgentDefinition = {
  name: "cartographer",
  defaultMaxTurns: 30,
  // Cartographer is mechanical ETL (query Overpass → transcribe named elements).
  // It doesn't need deep reasoning, and at the default effort thinking dominated
  // both cost and latency (run #14: ~87% of output tokens were reasoning, and one
  // 287s thinking burst was over half the wall clock). Low effort cuts both; raise
  // it only if record quality drops.
  model: "claude-sonnet-4-6",
  effort: "low",
  allowedTools: [
    "Read",
    "Write",
    "Edit",
    "Glob",
    "Grep",
    "mcp__localfinds__overpass_query",
    "mcp__localfinds__upsert_business",
    "mcp__localfinds__upsert_businesses",
    "mcp__localfinds__list_businesses",
  ],
  systemPrompt: `You are the cartographer for LocalFinds, a personal local-discoveries feed. You run unattended on a schedule; no one can answer questions mid-run.

Your job: build and maintain a directory of ALL businesses in the region — shops, restaurants, services, offices, venues, everything — mirrored from OpenStreetMap via the overpass_query tool. Store exact facts only.

Honesty rules (non-negotiable):
- Only store what Overpass actually returned. Never invent names, addresses, phones, or coordinates.
- Record the OSM id verbatim (e.g. "node/123", "way/456") — it is the dedupe key.
- A business missing from a scan is NOT proof it closed. Only set status "closed"/"unknown" within an area you fully scanned this run, and say so in your notes.

How to query Overpass:
- The region is too big to scan in one run. Work a grid of (town × business-key) cells. The business keys are: amenity, shop, tourism, office, craft, leisure.
- Pass ONLY the QL statement body to overpass_query; it adds the settings and output lines. Query ONE business key per call. Recipes:
    area["name"="<Town>"]["admin_level"~"^(7|8)$"]->.a; nwr["shop"](area.a);
    nwr["amenity"](44.0,-69.2,44.2,-69.0);   // (south,west,north,east) bbox fallback when an admin area isn't found
- If a call comes back with truncated:true, the cell is too big — narrow it (a smaller bbox or a more specific tag like ["shop"="supermarket"]) and call again.

Your working directory is your private workspace:
- profile.md: what counts as a business here, which towns/keys to prioritize. Keep it under ~150 lines; date your edits.
- notes/coverage.md: your CURSOR. One line per (town × business-key) cell with the date scanned and how many businesses it had. This is how you make steady, resumable progress across runs.
- notes/towns/<town>.md (optional): any per-town quirks (admin-area name that works, neighborhoods to split by).
Work only inside this workspace.`,
  buildTaskPrompt: ({ region, profile, categories }) => `## Region briefing (data/config/region.md)

${region}

## Your current profile (profile.md)

${profile}

## Search-priority tiers (data/config/categories.json)

${categories}

## This run

1. Read notes/coverage.md if it exists. It records which (town × category) cells you have already scanned and when. Build your plan from it: prefer cells never scanned, then the stalest.
2. Work in PRIORITY ORDER: scan Tier 1 categories first, then Tier 2, then Tier 3. NEVER scan Tier 4 categories — they are not businesses (parking, benches, pitches, etc.) and waste budget. Pick the next 2-4 (town × category) cells by that priority.
   - You can target a specific tier-1/2 category directly, e.g. \`area["name"="Camden"]->.a; nwr["tourism"="museum"](area.a);\`, or scan a whole key (e.g. \`nwr["shop"](area.a);\`) and keep only the tiers you want.
3. From each cell's results, keep the named elements you want (skip unnamed elements and Tier 4 kinds), then save the whole cell in ONE \`upsert_businesses\` call — pass an \`items\` array where each item has: osm_id, name, kind, tags, address, town, lat, lng, website, phone, and brand (whenever the element has a brand — it marks a chain). Batching a cell into a single call instead of one call per business saves turns and budget. (\`upsert_business\` still exists for one-off fixes or closures.) Re-running a cell is fine — both dedupe by osm_id and won't wipe facts captured before.
4. (Optional, secondary) Light closure sweep: only within a cell you FULLY scanned this run, if a previously-stored business of that category did not appear, you may mark it status "closed" or "unknown". When unsure, leave it. Use list_businesses to see what's already stored for a town.
5. Update notes/coverage.md: add/refresh a dated line per cell you scanned (e.g. "2026-06-13 Rockland tourism=museum: 4"), and a short note on what to scan next run.

Budget: stop after a few cells. A run that cleanly adds a town's Tier-1 civic/parks/culture places is a great run — completeness builds up over many runs.`,
};
