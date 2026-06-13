import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import {
  insertFind,
  listBusinesses,
  listRecentFinds,
  listSources,
  readFeedbackForAgent,
  setFindExpiry,
  updateFindStatus,
  upsertBusiness,
  upsertSource,
} from "@localfinds/db";
import { z } from "zod";

export interface RunCounters {
  added: number;
  updated: number;
}

function asText(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

const findStatus = z.enum(["new", "shown", "hidden", "starred"]);

// --- OpenStreetMap / Overpass helpers (used by the cartographer's overpass_query) ---

// Public Overpass instances, tried in order on rate-limit/timeout.
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

// OSM top-level keys that denote a "business". First match becomes the `kind`.
const BUSINESS_KEYS = [
  "amenity",
  "shop",
  "tourism",
  "office",
  "craft",
  "leisure",
];

interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

function primaryKind(tags: Record<string, string>): string | null {
  for (const key of BUSINESS_KEYS) {
    if (tags[key]) return `${key}=${tags[key]}`;
  }
  return null;
}

// A few lowercase free-form tags for filtering — the business-key values plus
// cuisine, capped. No controlled taxonomy; just useful chips.
function tagList(tags: Record<string, string>): string[] {
  const out: string[] = [];
  for (const key of BUSINESS_KEYS) {
    if (tags[key]) out.push(...tags[key].split(";"));
  }
  if (tags.cuisine) out.push(...tags.cuisine.split(";"));
  const seen = new Set<string>();
  return out
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t && !seen.has(t) && (seen.add(t), true))
    .slice(0, 12);
}

function composeAddr(tags: Record<string, string>): string | null {
  const street = [tags["addr:housenumber"], tags["addr:street"]]
    .filter(Boolean)
    .join(" ");
  const parts = [street, tags["addr:city"]].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

function projectElement(el: OverpassElement) {
  const tags = el.tags ?? {};
  return {
    osmId: `${el.type}/${el.id}`,
    name: tags.name ?? null,
    lat: el.lat ?? el.center?.lat ?? null,
    lng: el.lon ?? el.center?.lon ?? null,
    kind: primaryKind(tags),
    tags: tagList(tags),
    website: tags.website ?? tags["contact:website"] ?? null,
    phone: tags.phone ?? tags["contact:phone"] ?? null,
    // brand present = national/regional chain (lowest search priority)
    brand: tags.brand ?? null,
    addr: composeAddr(tags),
  };
}

type OverpassResult =
  | { ok: true; elements: OverpassElement[] }
  | { ok: false; error: string; status?: number };

async function runOverpass(ql: string): Promise<OverpassResult> {
  let last: OverpassResult = { ok: false, error: "no endpoints tried" };
  for (const endpoint of OVERPASS_ENDPOINTS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 32_000);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent":
            "LocalFinds/1.0 (cartographer agent; personal local-discovery directory)",
        },
        body: new URLSearchParams({ data: ql }).toString(),
        signal: controller.signal,
      });
      // 429/504 = overloaded → try the next mirror.
      if (res.status === 429 || res.status === 504) {
        last = { ok: false, error: `Overpass HTTP ${res.status}`, status: res.status };
        continue;
      }
      if (!res.ok) {
        return { ok: false, error: `Overpass HTTP ${res.status}`, status: res.status };
      }
      if (!(res.headers.get("content-type") ?? "").includes("json")) {
        return {
          ok: false,
          error: "Overpass returned a non-JSON body (query error or rate limit).",
        };
      }
      const json = (await res.json()) as { elements?: OverpassElement[] };
      return { ok: true, elements: json.elements ?? [] };
    } catch (err) {
      // Network failure or client timeout → try the next mirror.
      last = { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  }
  return last;
}

// Strip any settings line / out statement the agent supplied; the tool owns those.
function wrapOverpassQL(statement: string): string {
  const body = statement
    .replace(/\[(out|timeout|maxsize|bbox|diff|date)[^\]]*\]/gi, "")
    .replace(/\bout\b[^;]*;/gi, "")
    .replace(/^[\s;]+/, "")
    .trim();
  return `[out:json][timeout:25];\n${body}\nout tags center;`;
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
        async (args) => {
          const result = await runOverpass(wrapOverpassQL(args.statement));
          if (!result.ok) {
            return asText({
              error: result.error,
              status: result.status,
              hint: "Query too large or Overpass is busy. Narrow to one business key and a single town/bbox, then retry.",
            });
          }
          const cap = Math.min(Math.max(args.limit ?? 80, 1), 150);
          const named = result.elements
            .map(projectElement)
            .filter((e) => e.name);
          const elements = named.slice(0, cap);
          return asText({
            matched: named.length,
            returned: elements.length,
            truncated: named.length > cap,
            elements,
          });
        },
      ),
      tool(
        "upsert_business",
        "Save or update one business in the directory (matched by osm_id). Store exact facts only — put any judgment in your workspace note. Returns whether it was 'created' or 'updated'.",
        {
          osm_id: z
            .string()
            .describe('OSM stable id, e.g. "node/123" / "way/456" / "relation/789"'),
          name: z.string(),
          kind: z
            .string()
            .optional()
            .describe('Verbatim OSM primary tag, e.g. "amenity=cafe"'),
          tags: z
            .array(z.string())
            .optional()
            .describe("A few lowercase free-form tags"),
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
        },
        async (args) => {
          const result = upsertBusiness({
            osmId: args.osm_id,
            name: args.name,
            kind: args.kind,
            tags: args.tags,
            address: args.address,
            town: args.town,
            lat: args.lat,
            lng: args.lng,
            website: args.website,
            phone: args.phone,
            brand: args.brand,
            status: args.status,
            notesPath: args.notes_path,
            addedBy: agent,
          });
          if (result.outcome === "created") counters.added++;
          else counters.updated++;
          return asText(result);
        },
      ),
      tool(
        "list_businesses",
        "List businesses already in the directory — to dedupe your coverage, or to use them as monitoring targets / candidate sources. Filter by town, tag, status, or name substring.",
        {
          town: z.string().optional(),
          tag: z.string().optional(),
          status: z.enum(["active", "closed", "unknown"]).optional(),
          q: z.string().optional().describe("Name substring match"),
          limit: z.number().optional().describe("Default 500"),
        },
        async (args) => asText(listBusinesses(args)),
      ),
    ],
  });
}
