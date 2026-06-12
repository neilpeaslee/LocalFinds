import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import {
  insertFind,
  listRecentFinds,
  listSources,
  readFeedbackForAgent,
  setFindExpiry,
  updateFindStatus,
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
    ],
  });
}
