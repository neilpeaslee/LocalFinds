// The interviewer's MCP toolset + the surface-agnostic interactivity seam.
//
// InterviewIO is the seam: the CLI runner backs it with readline (+ journaling),
// a future web chat page backs it with a socket — buildInterviewerServer, the
// config writers, and the geocoder are identical either way.
//
// The meaty, risk-bearing logic (set_towns' preserve-existing-bbox / geocode-
// only-new rule) lives in exported pure-ish functions so it's unit-tested
// directly, with the tool() wrappers as thin adapters.

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import fs from "node:fs";
import path from "node:path";
import {
  listProvisionalFinds,
  readCategoryConfig,
  readIcpProfile,
  readRegionConfig,
  readTownsConfig,
  townsConfigPath,
  writeCategoryConfig,
  writeIcpProfile,
  writeRegionConfig,
  writeTownsConfig,
  type WritableTown,
} from "@localfinds/db";
import { z } from "zod";
import { geocodeTowns, type GeocodeInput, type GeocodeResult } from "./geocode";

export interface InterviewIO {
  /** Ask the human and block until they answer — no timeout. Interactive only. */
  ask(question: string, opts?: { choices?: string[] }): Promise<string>;
  /** Surface a message to the human (no answer expected). */
  say(message: string): void;
}

// Geocode a batch of towns. Injected so tests run with zero network.
export type GeocodeFn = (inputs: GeocodeInput[]) => Promise<GeocodeResult[]>;

export interface InterviewerDeps {
  geocode?: GeocodeFn;
}

function asText(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

// region.md frontmatter is "Town, State" (e.g. "Rockland, Maine"); the state is
// the last comma-separated segment. Used to give Nominatim a state for new towns.
export function deriveState(regionName: string): string {
  const parts = regionName.split(",").map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : regionName;
}

function hasValidBbox(t: WritableTown | undefined): t is WritableTown {
  return (
    !!t &&
    Array.isArray(t.bbox) &&
    t.bbox.length === 4 &&
    t.bbox.every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

export interface SetTownsInput {
  name: string;
  county?: string;
  primary?: boolean;
  query?: string;
}

export interface PerTownResult {
  name: string;
  bbox?: [number, number, number, number];
  error?: string;
  /** true = kept an existing hand-tuned bbox; false = freshly geocoded. */
  reused: boolean;
}

export interface ResolveTownsResult {
  /** The towns to write — only those with a valid bbox (reused or geocoded). */
  towns: WritableTown[];
  /** Per-town outcome for the agent (so it can re-ask towns that errored). */
  perTown: PerTownResult[];
  /** A town was added or removed → map polygons need a boundaries:fetch. */
  coordsChanged: boolean;
}

// The data-safety core. Existing towns keep their EXACT hand-tuned bbox (the
// town-boundaries.json polygons are matched to those values, and re-geocoding
// could pick a different OSM entity). Only genuinely new/renamed towns are
// geocoded, in one batch. A town that fails to geocode is reported but excluded
// from the write (we never write a town without a bbox). Pure: geocoder injected.
export async function resolveTowns(
  inputs: SetTownsInput[],
  existing: WritableTown[],
  state: string,
  geocode: GeocodeFn,
): Promise<ResolveTownsResult> {
  const byName = new Map(existing.map((t) => [t.name.toLowerCase(), t]));
  const inputNames = new Set(inputs.map((i) => i.name.toLowerCase()));

  const toGeocode = inputs.filter((i) => !hasValidBbox(byName.get(i.name.toLowerCase())));
  const geoResults = toGeocode.length
    ? await geocode(
        toGeocode.map((i) => ({
          name: i.name,
          ...(i.county ? { county: i.county } : {}),
          state,
          ...(i.query ? { query: i.query } : {}),
        })),
      )
    : [];
  const geoByName = new Map(geoResults.map((r) => [r.name.toLowerCase(), r]));

  const towns: WritableTown[] = [];
  const perTown: PerTownResult[] = [];
  let geocodedOk = 0;

  for (const input of inputs) {
    const ex = byName.get(input.name.toLowerCase());
    if (hasValidBbox(ex)) {
      const county = input.county ?? ex.county;
      const query = input.query ?? ex.query;
      towns.push({
        name: input.name,
        bbox: ex.bbox,
        ...(county ? { county } : {}),
        ...(query ? { query } : {}),
        ...(input.primary ? { primary: true } : {}),
      });
      perTown.push({ name: input.name, bbox: ex.bbox, reused: true });
      continue;
    }
    const g = geoByName.get(input.name.toLowerCase());
    if (g && !("error" in g)) {
      towns.push({
        name: input.name,
        bbox: g.bbox,
        ...(input.county ? { county: input.county } : {}),
        ...(input.query ? { query: input.query } : {}),
        ...(input.primary ? { primary: true } : {}),
      });
      perTown.push({ name: input.name, bbox: g.bbox, reused: false });
      geocodedOk++;
    } else {
      perTown.push({
        name: input.name,
        error: g && "error" in g ? g.error : "geocoding failed",
        reused: false,
      });
    }
  }

  const removedAny = existing.some((e) => !inputNames.has(e.name.toLowerCase()));
  return { towns, perTown, coordsChanged: geocodedOk > 0 || removedAny };
}

// Read the current towns plus the file's `_comment` (which readTownsConfig drops)
// so the writer can round-trip the human notes instead of wiping them.
function readExistingTowns(): { towns: WritableTown[]; comment?: string } {
  const towns = readTownsConfig().towns as WritableTown[];
  let comment: string | undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(townsConfigPath(), "utf8"));
    if (typeof parsed?._comment === "string") comment = parsed._comment;
  } catch {
    // no file or no comment — nothing to preserve
  }
  return { towns, comment };
}

// set_towns end to end: requires a region (for the state), preserves existing
// bboxes, writes, and reminds about boundaries:fetch when coordinates changed.
export async function runSetTowns(
  inputs: SetTownsInput[],
  io: InterviewIO,
  geocode: GeocodeFn,
): Promise<PerTownResult[]> {
  const region = readRegionConfig();
  if (!region) {
    throw new Error(
      "Set the region first (set_region) — towns need a state to geocode against.",
    );
  }
  const state = deriveState(region.name);
  const { towns: existing, comment } = readExistingTowns();
  const res = await resolveTowns(inputs, existing, state, geocode);
  writeTownsConfig(res.towns, comment ? { comment } : {});
  if (res.coordsChanged) {
    io.say(
      "Town coordinates changed — run `npm run boundaries:fetch` to resync the map polygons.",
    );
  }
  return res.perTown;
}

// Snapshot of every config the interviewer edits, as plain serializable data
// (no methods) so it round-trips through asText. Nulls signal "not set yet".
export function currentConfig() {
  const region = readRegionConfig();
  const cat = readCategoryConfig();
  return {
    region: region ? { name: region.name, raw: region.raw } : null,
    towns: readTownsConfig().towns,
    categories: {
      defaultTier: cat.defaultTier,
      hideInDirectory: cat.hideInDirectory,
      tiers: cat.tiers,
    },
    icp: readIcpProfile(),
  };
}

export interface ReviewProbe {
  topic: string;
  observation: string;
  askUser: string;
}

export interface ReviewResult {
  report: string;
  calibration: string;
  probes: ReviewProbe[];
}

export interface ReviewSink {
  value?: ReviewResult;
}

export interface ReviewContext {
  runId: number;
  /** The staged prospector workspace — where coverage.md was written. */
  scratchDir: string;
}

// What the sample run produced: provisional leads (real DB) + the run's own
// narrative coverage note (where it explains what it skipped and why).
export function reviewRunResults(ctx: ReviewContext) {
  const leads = listProvisionalFinds().map((f) => ({
    title: f.title,
    score: f.score,
    url: f.url,
    summary: f.summary,
    tags: f.tags,
  }));
  let coverageNote: string | null = null;
  try {
    coverageNote = fs.readFileSync(path.join(ctx.scratchDir, "notes", "coverage.md"), "utf8");
  } catch {
    coverageNote = null; // run wrote no coverage
  }
  return { runId: ctx.runId, leads, coverageNote };
}

export function buildReviewServer(io: InterviewIO, ctx: ReviewContext, sink: ReviewSink) {
  return createSdkMcpServer({
    name: "interviewer",
    version: "1.0.0",
    tools: [
      tool(
        "say",
        "Show the user a message (no answer expected).",
        { message: z.string() },
        async (args) => {
          io.say(args.message);
          return asText({ ok: true });
        },
      ),
      tool(
        "read_current_config",
        "Read the just-staged region, towns, category tiers, and ICP. Nulls mean 'not set yet'.",
        {},
        async () => asText(currentConfig()),
      ),
      tool(
        "read_run_results",
        "Read what the sample prospector run produced: the provisional leads it saved " +
          "(name, score, summary, tags) and the coverage note it wrote (its narrative — " +
          "what it walked, what it SKIPPED and why). Use the narrative to catch ICP " +
          "self-contradictions and mis-scoring, not just the leads it kept.",
        {},
        async () => asText(reviewRunResults(ctx)),
      ),
      tool(
        "submit_review",
        "Record your finished review. `report` is shown to the user; `probes` are the " +
          "specific things the NEXT conversation should raise (empty on the final review). " +
          "Call this exactly once, last.",
        {
          report: z.string().describe("Human-facing summary of this cycle."),
          calibration: z.string().describe("Scoring-calibration notes (over/under-scoring)."),
          probes: z
            .array(
              z.object({
                topic: z.string(),
                observation: z.string(),
                askUser: z.string(),
              }),
            )
            .describe("Findings to carry into the next conversation. Empty on the final cycle."),
        },
        async (args) => {
          sink.value = { report: args.report, calibration: args.calibration, probes: args.probes };
          io.say(args.report);
          return asText({ ok: true });
        },
      ),
    ],
  });
}

export function buildInterviewerServer(io: InterviewIO, deps: InterviewerDeps = {}) {
  const geocode: GeocodeFn = deps.geocode ?? ((inputs) => geocodeTowns(inputs));

  return createSdkMcpServer({
    name: "interviewer",
    version: "1.0.0",
    tools: [
      tool(
        "ask_user",
        "Ask the user one question and wait for their typed answer. Use for the live, adaptive interview. Returns { answer }.",
        {
          question: z.string().describe("A single, clear question."),
          choices: z
            .array(z.string())
            .optional()
            .describe("Optional suggested answers to offer."),
        },
        async (args) => {
          const answer = await io.ask(args.question, { choices: args.choices });
          return asText({ answer });
        },
      ),
      tool(
        "say",
        "Show the user a message (no answer expected) — context, a heads-up, or a summary.",
        { message: z.string() },
        async (args) => {
          io.say(args.message);
          return asText({ ok: true });
        },
      ),
      tool(
        "read_current_config",
        "Read the current region, towns, category tiers, and ICP. Nulls mean 'not set yet'. Call this FIRST so you edit rather than blindly overwrite.",
        {},
        async () => asText(currentConfig()),
      ),
      tool(
        "geocode_town",
        "Preview a town's bbox before committing it. Returns { name, bbox, lat, lng } or { error }. Does NOT write anything.",
        {
          name: z.string(),
          county: z.string().optional().describe('County context, e.g. "Knox County".'),
          query: z.string().optional().describe("Override search term for odd names."),
        },
        async (args) => {
          const region = readRegionConfig();
          if (!region) return asText({ error: "Set the region first (set_region)." });
          const state = deriveState(region.name);
          const [result] = await geocode([
            {
              name: args.name,
              ...(args.county ? { county: args.county } : {}),
              state,
              ...(args.query ? { query: args.query } : {}),
            },
          ]);
          return asText(result);
        },
      ),
      tool(
        "set_region",
        "Write the region: a display name (\"Town, State\") and the coverage prose. The state in the name is reused to geocode towns.",
        {
          name: z.string().describe('Display name, e.g. "Rockland, Maine".'),
          coverage_markdown: z
            .string()
            .describe("Markdown describing the coverage area (towns, scope, notes)."),
        },
        async (args) => {
          writeRegionConfig({ name: args.name, coverageMarkdown: args.coverage_markdown });
          return asText({ ok: true });
        },
      ),
      tool(
        "set_towns",
        "Write the full town list. Existing towns KEEP their hand-tuned bbox; only new towns are geocoded. Supply county for disambiguation; never supply coordinates. Returns per-town { name, bbox | error }.",
        {
          towns: z
            .array(
              z.object({
                name: z.string(),
                county: z.string().optional(),
                primary: z.boolean().optional().describe("The home town (one only)."),
                query: z.string().optional(),
              }),
            )
            .describe("The complete town list (this replaces the current list)."),
        },
        async (args) => {
          const perTown = await runSetTowns(args.towns, io, geocode);
          return asText({ towns: perTown });
        },
      ),
      tool(
        "set_categories",
        "Write the business-category search tiers (OSM key=value). Tier 1 = highest priority, 4 = excluded. Use \"key=*\" to match any value of a key.",
        {
          default_tier: z.number().describe("Tier for categories not listed (the live default is 3)."),
          hide_tier4: z.boolean().describe("Hide tier-4 categories from the /businesses directory."),
          hide_chains: z.boolean().describe("Hide national/regional chains from the directory."),
          tiers: z
            .record(z.string(), z.array(z.string()))
            .describe('Map of tier number -> categories, e.g. {"1": ["amenity=library"]}.'),
        },
        async (args) => {
          writeCategoryConfig({
            default_tier: args.default_tier,
            hide_in_directory: { tier4: args.hide_tier4, chains: args.hide_chains },
            tiers: args.tiers,
          });
          return asText({ ok: true });
        },
      ),
      tool(
        "write_icp",
        "Write the prospector's Ideal Customer Profile (markdown). Reference the same towns/categories you set so prose and config agree.",
        { markdown: z.string().describe("The full ICP profile markdown.") },
        async (args) => {
          writeIcpProfile(args.markdown);
          return asText({ ok: true });
        },
      ),
    ],
  });
}
