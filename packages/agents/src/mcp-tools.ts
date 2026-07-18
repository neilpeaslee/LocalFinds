import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import {
  insertCustomPlace,
  insertFind,
  listPlacesRanked,
  listRecentFinds,
  listSources,
  readFeedbackForAgent,
  setFindExpiry,
  updateFindStatus,
  upsertPlaceAnnotation,
  upsertSource,
  type FindStatus,
} from "@localfinds/db";
import { z } from "zod";
import { formatIcalResult, runIcalFetch } from "./ical";
import { geocodeAddress, type AddressGeocodeResult, type AddressInput } from "./geocode";

export interface RunCounters {
  added: number;
  updated: number;
  /** Custom places created this run — post-run osm_places refresh trigger. */
  placesAdded: number;
}

// The status a save_find insert should use. undefined → insertFind defaults to
// "new". An interview sample run passes "provisional" so its leads stay out of
// the feed until the interview is confirmed.
export function resolveFindStatus(override: FindStatus | undefined): FindStatus | undefined {
  return override;
}

function asText(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

// Reused on every agent-authored display field. Models tend to HTML-escape
// ampersands ("Programs &amp; Events"); the value is stored and shown verbatim,
// so it must be plain text.
const PLAIN_TEXT = "Plain text — write a literal & (do not HTML-escape to &amp;).";

export interface SourceUpsertArgs {
  url: string;
  name?: string;
  status?: "active" | "paused" | "dead";
  quality_score?: number;
  notes_path?: string;
  ical_url?: string;
}

// Upsert a source and tally it against the run counters. Mirrors
// upsertOneBusiness: a brand-new URL is `added`, an existing one is `updated`.
export async function recordSourceUpsert(
  args: SourceUpsertArgs,
  agent: string,
  counters: RunCounters,
) {
  const result = await upsertSource({
    url: args.url,
    name: args.name,
    status: args.status,
    qualityScore: args.quality_score,
    notesPath: args.notes_path,
    icalUrl: args.ical_url,
    addedBy: agent,
  });
  if (result.outcome === "created") counters.added++;
  else counters.updated++;
  return result;
}

const PLACE_CATEGORY_KEYS = ["amenity", "shop", "tourism", "office", "craft", "leisure"];

export interface SavePlaceArgs {
  name: string;
  category: string;
  housenumber?: string;
  street: string;
  city: string;
  state?: string;
  postcode?: string;
  website?: string;
  phone?: string;
  source_url: string;
}

export type SavePlaceResult =
  | { outcome: "created" | "duplicate"; osmId: string }
  | { outcome: "error"; reason: string };

export type GeocodeAddressFn = (input: AddressInput) => Promise<AddressGeocodeResult>;

// save_place handler, geocoder injected for tests. The tool owns coordinates:
// the agent supplies a street address + the page it confirmed it at, never lat/lng.
export async function recordPlaceSave(
  args: SavePlaceArgs,
  agent: string,
  counters: RunCounters,
  geocode: GeocodeAddressFn,
): Promise<SavePlaceResult> {
  const parts = args.category.split("=");
  const [key, value] = parts;
  if (parts.length !== 2 || !PLACE_CATEGORY_KEYS.includes(key) || !value) {
    return {
      outcome: "error",
      reason: `category must be exactly key=value (one "=", both parts non-empty) with key one of ${PLACE_CATEGORY_KEYS.join("|")} (got "${args.category}")`,
    };
  }
  if (!args.street?.trim()) {
    return {
      outcome: "error",
      reason: "street is required — save_place only with a real, confirmed street address. If you cannot confirm one, save your find without a place link instead.",
    };
  }
  const state = args.state?.trim() || undefined;
  const geo = await geocode({
    housenumber: args.housenumber,
    street: args.street,
    city: args.city,
    state,
    postcode: args.postcode,
  });
  if (!geo.ok) {
    return {
      outcome: "error",
      reason: `geocoding failed: ${geo.error}. Save your find without a place link and record the failure in your scan note.`,
    };
  }
  const result = await insertCustomPlace({
    name: args.name,
    category: args.category,
    housenumber: args.housenumber,
    street: args.street,
    city: args.city,
    state,
    postcode: args.postcode,
    lat: geo.lat,
    lng: geo.lng,
    website: args.website,
    phone: args.phone,
    sourceUrl: args.source_url,
    addedBy: agent,
  });
  if (result.outcome === "created") {
    counters.added++;
    counters.placesAdded++;
  }
  return result;
}

export interface AnnotatePlaceArgs {
  osm_id: string;
  note?: string;
  status_override?: "closed" | "unknown" | "clear";
  duplicate_of?: string;
}

export async function recordPlaceAnnotation(
  args: AnnotatePlaceArgs,
  agent: string,
  counters: RunCounters,
): Promise<{ ok: boolean; reason?: string }> {
  if (args.note === undefined && args.status_override === undefined && args.duplicate_of === undefined) {
    return { ok: false, reason: "provide at least one of note, status_override, duplicate_of" };
  }
  const result = await upsertPlaceAnnotation({
    osmId: args.osm_id,
    note: args.note,
    statusOverride: args.status_override,
    duplicateOf: args.duplicate_of,
    addedBy: agent,
  });
  if (result.ok) counters.updated++;
  return result;
}

const findStatus = z.enum(["new", "shown", "hidden", "starred"]);

// All tools are defined on one server; each agent's allowedTools picks its subset.
export function buildLocalfindsServer(
  agent: string,
  counters: RunCounters,
  opts: {
    findStatusOverride?: FindStatus;
    geocodeAddressImpl?: GeocodeAddressFn;
    geocodeThrottleMs?: number;
  } = {},
) {
  // Nominatim etiquette: ≤1 req/s across a whole run. The throttle lives here
  // (not in geocodeAddress) so it spans every save_place call this run makes.
  const geocodeImpl = opts.geocodeAddressImpl ?? geocodeAddress;
  const throttleMs = opts.geocodeThrottleMs ?? 1100;
  let lastGeocodeAt = 0;
  const throttledGeocode: GeocodeAddressFn = async (input) => {
    const wait = lastGeocodeAt + throttleMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastGeocodeAt = Date.now();
    return geocodeImpl(input);
  };

  return createSdkMcpServer({
    name: "localfinds",
    version: "1.0.0",
    tools: [
      tool(
        "save_find",
        "Save a local find to the feed. Call this once per genuinely local, current item you verified at a real page. Returns 'duplicate' if the (normalized) URL was already saved.",
        {
          title: z.string().describe(`Headline for the feed card. ${PLAIN_TEXT}`),
          url: z.string().optional().describe("Canonical page URL"),
          summary: z
            .string()
            .optional()
            .describe(`1-2 sentence summary of why this is interesting. ${PLAIN_TEXT}`),
          event_start: z
            .string()
            .optional()
            .describe("ISO 8601 date/datetime if this is an event"),
          event_end: z.string().optional(),
          expires_at: z
            .string()
            .optional()
            .describe("ISO 8601 date after which this is stale"),
          published_at: z.string().optional(),
          tags: z
            .array(z.string())
            .optional()
            .describe("A few lowercase free-form tags"),
          source_url: z
            .string()
            .optional()
            .describe("URL of the registered source this came from, if any"),
          type: z
            .string()
            .optional()
            .describe('Find type — omit for an event (default), or "lead" for a qualified business lead.'),
          place_osm_id: z
            .string()
            .optional()
            .describe(
              "For a lead: the osm_id of the linked place (from list_businesses, or returned by save_place).",
            ),
          score: z
            .number()
            .optional()
            .describe("0-1 fit/quality score (e.g. a lead's ICP fit)."),
        },
        async (args) => {
          const result = await insertFind({
            title: args.title,
            url: args.url,
            summary: args.summary,
            eventStart: args.event_start,
            eventEnd: args.event_end,
            expiresAt: args.expires_at,
            publishedAt: args.published_at,
            tags: args.tags,
            sourceUrl: args.source_url,
            type: args.type,
            placeOsmId: args.place_osm_id,
            score: args.score,
            agent,
            status: resolveFindStatus(opts.findStatusOverride),
          });
          if (result.outcome === "created") counters.added++;
          return asText(result);
        },
      ),
      tool(
        "list_recent_finds",
        "List finds already in the feed (so you don't re-save them, or to review them for curation).",
        {
          days: z.number().optional().describe("Look-back window, default 7"),
          status: findStatus.optional(),
          limit: z.number().optional().describe("Default 100"),
        },
        async (args) => asText(await listRecentFinds(args)),
      ),
      tool(
        "update_find_status",
        "Set a find's status. Use 'hidden' for duplicates or off-target items; give a short reason.",
        {
          id: z.number(),
          status: findStatus,
          reason: z
            .string()
            .optional()
            .describe("One line on why — also record it in your notes"),
        },
        async (args) => {
          const ok = await updateFindStatus(args.id, args.status);
          if (ok) counters.updated++;
          return asText({ ok, id: args.id, status: args.status });
        },
      ),
      tool(
        "set_find_expiry",
        "Set expires_at on a find so it ages out of the feed (e.g. after its event date).",
        {
          id: z.number(),
          expires_at: z.string().describe("ISO 8601"),
        },
        async (args) => {
          const ok = await setFindExpiry(args.id, args.expires_at);
          if (ok) counters.updated++;
          return asText({ ok, id: args.id });
        },
      ),
      tool(
        "read_feedback",
        "Read the user's feed feedback (stars, hides, thumbs) that is new since your last successful run. Use it to update your profile.md.",
        {
          limit: z.number().optional().describe("Default 200"),
        },
        async (args) => asText(await readFeedbackForAgent(agent, args.limit)),
      ),
      tool(
        "list_sources",
        "List the registered sources (local sites worth checking) with status and quality signals.",
        {},
        async () => asText(await listSources()),
      ),
      tool(
        "upsert_source",
        "Register a new source or update an existing one (matched by URL). Also bumps last_checked_at.",
        {
          url: z.string(),
          name: z.string().optional().describe(PLAIN_TEXT),
          status: z.enum(["active", "paused", "dead"]).optional(),
          quality_score: z
            .number()
            .optional()
            .describe("0-1 coarse signal; keep the real judgment in your site notes"),
          notes_path: z
            .string()
            .optional()
            .describe("Workspace-relative path to your site note, e.g. notes/sites/example.org.md"),
          ical_url: z
            .string()
            .optional()
            .describe("iCal feed URL for this source, if it has one (e.g. The Events Calendar ?ical=1)"),
        },
        async (args) => asText(await recordSourceUpsert(args, agent, counters)),
      ),
      tool(
        "fetch_ical",
        "Fetch a venue's iCal calendar feed and return its upcoming events as structured data (summary, start, end, url, location). Pass the venue's site or events-page URL — the tool probes the common feed URLs (e.g. ?ical=1) itself and returns the resolved feedUrl. Works on many sites whose HTML blocks WebFetch (403). Use the per-event url when saving a find.",
        {
          url: z.string().describe("The venue's site, events-page, or known iCal feed URL"),
          limit: z.number().optional().describe("Max upcoming events to return, default 30, capped at 60"),
        },
        async (args) => formatIcalResult(await runIcalFetch(args.url), args.limit),
      ),
      tool(
        "list_businesses",
        "List businesses already in the directory — to dedupe your coverage, or to use them as monitoring targets / candidate sources. Each row includes `tier` (1 = highest search priority) and `isChain`. Filter by town, tag, status, name substring, `max_tier` (e.g. 2 = Tier 1-2 only), `exclude_chains`, or `has_website` (only businesses with a website — the candidate sources).",
        {
          town: z.string().optional(),
          tag: z.string().optional(),
          status: z.enum(["active", "closed", "unknown"]).optional(),
          q: z.string().optional().describe("Name substring match"),
          max_tier: z
            .number()
            .optional()
            .describe("Only Tier <= this (1 = highest). E.g. 2 = Tier 1-2 only."),
          exclude_chains: z
            .boolean()
            .optional()
            .describe("Drop national/regional chains (OSM brand)."),
          has_website: z
            .boolean()
            .optional()
            .describe("Only businesses that have a website — the candidate sources."),
          limit: z.number().optional().describe("Default 500"),
        },
        async (args) => {
          const { rows, total } = await listPlacesRanked({
            town: args.town,
            tag: args.tag,
            status: args.status,
            q: args.q,
            hasWebsite: args.has_website,
            limit: args.limit,
            maxTier: args.max_tier,
            includeTier4: true, // maxTier governs; otherwise return the full set
            includeChains: !args.exclude_chains,
          });
          return asText({
            total,
            returned: rows.length,
            // Trim to the fields an agent needs to judge a directory row (dedupe
            // by town/name, or weigh it as a candidate source) — dropping coords,
            // phone, and timestamps keeps a tier-wide list from blowing the token
            // budget. The full record is available via the /businesses page.
            businesses: rows.map((r) => ({
              osmId: r.place.osmId,
              name: r.place.name,
              kind: r.place.kind,
              tags: r.place.tags,
              town: r.place.town,
              address: r.place.address,
              website: r.place.website,
              status: r.place.status,
              tier: r.tier,
              isChain: r.isChain,
            })),
          });
        },
      ),
      tool(
        "save_place",
        "Add a business to the directory that is missing from it. ONLY for businesses physically located in the region, confirmed at a real page (source_url). The tool geocodes the address itself — give the real street address, never invent one. Returns the new place's osm_id (custom/<n>) — use it as place_osm_id when you save a lead for this business. Returns 'duplicate' with the existing osm_id if the place is already in the directory.",
        {
          name: z.string().describe(`Business name. ${PLAIN_TEXT}`),
          category: z
            .string()
            .describe("OSM key=value, e.g. office=lawyer. Key must be one of amenity|shop|tourism|office|craft|leisure."),
          housenumber: z.string().optional(),
          street: z
            .string()
            .describe(
              'Street name, e.g. "School Street" — required; save_place is only for businesses with a real, confirmed street address.',
            ),
          city: z.string().describe("Town the business is in"),
          state: z.string().optional().describe("Default ME"),
          postcode: z.string().optional(),
          website: z.string().optional(),
          phone: z.string().optional(),
          source_url: z
            .string()
            .describe("URL of the page where you confirmed this business exists — required."),
        },
        async (args) => asText(await recordPlaceSave(args, agent, counters, throttledGeocode)),
      ),
      tool(
        "annotate_place",
        "Record what you learned about an EXISTING directory entry: a correction note (renamed, moved, new site), a status_override ('closed' | 'unknown' | 'clear' to reset), or duplicate_of (osm_id of the canonical entry). Provide at least one field.",
        {
          osm_id: z.string().describe("The place's osm_id from list_businesses (or save_place)"),
          note: z.string().optional().describe(`Dated one-liner, e.g. "2026-07-02 scan: now Cumler, Lynch & Stiles". ${PLAIN_TEXT}`),
          status_override: z.enum(["closed", "unknown", "clear"]).optional(),
          duplicate_of: z.string().optional(),
        },
        async (args) => asText(await recordPlaceAnnotation(args, agent, counters)),
      ),
    ],
  });
}
