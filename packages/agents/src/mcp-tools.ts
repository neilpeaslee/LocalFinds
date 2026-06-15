import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import {
  insertFind,
  listBusinessesRanked,
  listRecentFinds,
  listSources,
  readFeedbackForAgent,
  setFindExpiry,
  updateFindStatus,
  upsertBusiness,
  upsertSource,
} from "@localfinds/db";
import { z } from "zod";
import {
  formatOverpassResult,
  isValidOsmId,
  runOverpass,
  wrapOverpassQL,
} from "./overpass";

export interface RunCounters {
  added: number;
  updated: number;
}

function asText(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

const findStatus = z.enum(["new", "shown", "hidden", "starred"]);

// Shared shape for one business row — used by both upsert_business (a single
// row) and upsert_businesses (a batch), so their fields and validation stay
// identical.
const businessShape = {
  osm_id: z
    .string()
    .describe('OSM stable id, e.g. "node/123" / "way/456" / "relation/789"'),
  name: z.string(),
  kind: z
    .string()
    .optional()
    .describe('Verbatim OSM primary tag, e.g. "amenity=cafe"'),
  tags: z.array(z.string()).optional().describe("A few lowercase free-form tags"),
  address: z.string().optional(),
  town: z.string().optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  website: z.string().optional(),
  phone: z.string().optional(),
  brand: z
    .string()
    .optional()
    .describe("OSM brand tag if present — marks a national/regional chain"),
  status: z.enum(["active", "closed", "unknown"]).optional(),
  notes_path: z
    .string()
    .optional()
    .describe("Workspace-relative path to a note, e.g. notes/towns/rockland.md"),
};
const businessSchema = z.object(businessShape);
type BusinessInput = z.infer<typeof businessSchema>;

// Validate + coerce one business row and write it. Returns the upsert result,
// or an { osm_id, error } object the caller can surface without aborting a batch.
function upsertOneBusiness(
  item: BusinessInput,
  agent: string,
  counters: RunCounters,
) {
  // osm_id is the unique dedupe key and is rendered into an OSM URL — reject
  // free text rather than storing a junk key / broken link.
  if (!isValidOsmId(item.osm_id)) {
    return {
      osm_id: item.osm_id,
      error: `invalid osm_id "${item.osm_id}" — expected "node/<n>", "way/<n>", or "relation/<n>"`,
    };
  }
  // Drop out-of-range coordinates instead of persisting a bad pin.
  const lat = item.lat != null && Math.abs(item.lat) <= 90 ? item.lat : undefined;
  const lng = item.lng != null && Math.abs(item.lng) <= 180 ? item.lng : undefined;
  const result = upsertBusiness({
    osmId: item.osm_id.trim(),
    name: item.name,
    kind: item.kind,
    tags: item.tags,
    address: item.address,
    town: item.town,
    lat,
    lng,
    website: item.website,
    phone: item.phone,
    brand: item.brand,
    status: item.status,
    notesPath: item.notes_path,
    addedBy: agent,
  });
  if (result.outcome === "created") counters.added++;
  else counters.updated++;
  return result;
}

// All tools are defined on one server; each agent's allowedTools picks its subset.
export function buildLocalfindsServer(agent: string, counters: RunCounters) {
  return createSdkMcpServer({
    name: "localfinds",
    version: "1.0.0",
    tools: [
      tool(
        "save_find",
        "Save a local find to the feed. Call this once per genuinely local, current item you verified at a real page. Returns 'duplicate' if the (normalized) URL was already saved.",
        {
          title: z.string().describe("Headline for the feed card"),
          url: z.string().optional().describe("Canonical page URL"),
          summary: z
            .string()
            .optional()
            .describe("1-2 sentence summary of why this is interesting"),
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
        },
        async (args) => {
          const result = insertFind({
            title: args.title,
            url: args.url,
            summary: args.summary,
            eventStart: args.event_start,
            eventEnd: args.event_end,
            expiresAt: args.expires_at,
            publishedAt: args.published_at,
            tags: args.tags,
            sourceUrl: args.source_url,
            agent,
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
        async (args) => asText(listRecentFinds(args)),
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
          const ok = updateFindStatus(args.id, args.status);
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
          const ok = setFindExpiry(args.id, args.expires_at);
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
        async (args) => asText(readFeedbackForAgent(agent, args.limit)),
      ),
      tool(
        "list_sources",
        "List the registered sources (local sites worth checking) with status and quality signals.",
        {},
        async () => asText(listSources()),
      ),
      tool(
        "upsert_source",
        "Register a new source or update an existing one (matched by URL). Also bumps last_checked_at.",
        {
          url: z.string(),
          name: z.string().optional(),
          status: z.enum(["active", "paused", "dead"]).optional(),
          quality_score: z
            .number()
            .optional()
            .describe("0-1 coarse signal; keep the real judgment in your site notes"),
          notes_path: z
            .string()
            .optional()
            .describe("Workspace-relative path to your site note, e.g. notes/sites/example.org.md"),
        },
        async (args) => {
          const result = upsertSource({
            url: args.url,
            name: args.name,
            status: args.status,
            qualityScore: args.quality_score,
            notesPath: args.notes_path,
            addedBy: agent,
          });
          counters.updated++;
          return asText(result);
        },
      ),
      tool(
        "overpass_query",
        "Query OpenStreetMap via the Overpass API for businesses in an area. Pass ONLY the QL statement body (the tool adds `[out:json][timeout:25];` and `out tags center;` itself). Query ONE business key per call (amenity | shop | tourism | office | craft | leisure) to keep results small. Returns a projected, named-only, capped list. If `truncated` is true, narrow the query (smaller area or a more specific tag) and call again.\n\nExamples of the statement body:\n  area[\"name\"=\"Rockland\"][\"admin_level\"~\"^(7|8)$\"]->.a; nwr[\"shop\"](area.a);\n  nwr[\"amenity\"](44.0,-69.2,44.2,-69.0);   // (south,west,north,east) bbox fallback",
        {
          statement: z
            .string()
            .describe("Overpass QL statement body for one business key"),
          limit: z
            .number()
            .optional()
            .describe("Max named elements to return, default 80, capped at 150"),
        },
        async (args) =>
          formatOverpassResult(
            await runOverpass(wrapOverpassQL(args.statement)),
            args.limit,
          ),
      ),
      tool(
        "upsert_business",
        "Save or update one business in the directory (matched by osm_id). Store exact facts only — put any judgment in your workspace note. Returns whether it was 'created' or 'updated'. To save many at once, prefer upsert_businesses.",
        businessShape,
        async (args) => asText(upsertOneBusiness(args, agent, counters)),
      ),
      tool(
        "upsert_businesses",
        "Save or update MANY businesses in one call — each matched by osm_id, same fields as upsert_business. PREFER THIS when saving the results of a scan: one call per (town × category) cell instead of one call per business cuts turns and budget. Returns counts of created/updated plus any per-item errors (e.g. an invalid osm_id) — a bad row is skipped, the rest still save.",
        {
          items: z
            .array(businessSchema)
            .min(1)
            .max(200)
            .describe(
              "Businesses to upsert; skip unnamed elements and Tier 4 kinds before calling.",
            ),
        },
        async (args) => {
          const results = args.items.map((item) =>
            upsertOneBusiness(item, agent, counters),
          );
          const errors = results.filter(
            (r): r is { osm_id: string; error: string } => "error" in r,
          );
          const created = results.filter(
            (r) => "outcome" in r && r.outcome === "created",
          ).length;
          const updated = results.filter(
            (r) => "outcome" in r && r.outcome === "updated",
          ).length;
          return asText({
            count: args.items.length,
            created,
            updated,
            errors: errors.length,
            ...(errors.length ? { errorDetails: errors } : {}),
          });
        },
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
          const { rows, total } = listBusinessesRanked({
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
              id: r.business.id,
              osmId: r.business.osmId,
              name: r.business.name,
              kind: r.business.kind,
              tags: r.business.tags,
              town: r.business.town,
              address: r.business.address,
              website: r.business.website,
              status: r.business.status,
              tier: r.tier,
              isChain: r.isChain,
            })),
          });
        },
      ),
    ],
  });
}
