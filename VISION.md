# LocalFinds — Vision

*This is where LocalFinds is going. For what it does right now, read
[README.md](README.md).*

## Thesis

**LocalFinds is a network of local communities, each served by an
agent-maintained front page.**

For the place you live, it answers two questions:

- *"What's happening here?"* — standing: the feed, the directory, the calendars.
- *"I need X, here, now"* — in the moment: ask, and an agent goes to work for
  you.

"Local" is real geography. A region is a set of towns, and the people in it are
neighbors. The media it serves is local media only — the region's outlets,
venues, town notices. It is not a general reader, and not a social network with
a location filter.

The single-user phase proved the model on region #1, midcoast Maine. Its
biggest discovery — OpenStreetMap as a free, complete, continuously-updated
base layer — is what makes any region bootstrappable: a full directory exists
from day zero, so no region starts cold.

## The three layers

Three layers, each with a different owner and a different cost shape:

1. **The regional commons** *(shared; agent-maintained; cost scales with
   regions, not users).* The directory (OSM base + curated places +
   annotations), the feed, the source roster, the calendars. Maintained once
   per region by the scheduled agent roster (scout, source-keeper, curator).
2. **Personal service** *(per-user; on demand).* The concierge interaction is
   the archetype: ask for what you need now, watch your agent work, get an
   answer. Plus personal taste (feedback, profiles), personal subscriptions
   within the region, and standing personal missions — the prospector's ideal
   customer profile is a *personal* need, so it lives here, not in the commons.
3. **Community** *(people-to-people; realtime).* Chat, DMs, presence among
   people who share a place. Conversation happens around the commons: an event,
   a place, a find.

The flywheel that makes them one product rather than three: **personal needs
enrich the commons** (concierge writes back places and annotations), **the
commons feeds everyone's front page**, and **community closes the loop** —
locals discussing, correcting, and reacting *is* the feedback that tunes the
region's agents.

## The pieces already on the board

Every layer has a seed shipped and live; the vision extends what exists rather
than starting over.

| Vision element | Existing seed |
|---|---|
| Region bootstrap without cold start | The OSM base: PostGIS materialized view + daily replication — a complete directory from day zero |
| Commons maintenance | The scheduled roster (scout / source-keeper / curator) running region #1 unattended |
| Personal service archetype | Concierge: on-demand `--query` scans that answer and write back |
| Personal taste | Per-agent `profile.md` + the feedback loop (thumbs/star/hide → cursor) |
| Subscriptions primitive | `sources` + iCal feeds — subscribe-to-a-local-source exists, just not yet per-user |
| Community knowledge | `place_annotations` — locals correcting the map, current population: one |
| Watching your agent work | The SSE run viewer — deliberately one-way for now, so the realtime layer can choose its transport later |

## Operating model

**A civic utility.** Free to use; the aim is covering costs, not profit.

**Regions are provisioned on demand** — stood up centrally where a community
asks. A region carries real recurring cost (OSM import + replication + a daily
agent budget), and curated growth keeps that cost predictable and tied to
communities that want to exist, not to signups.

**Every region needs a steward** — someone to tune the category tiers, the
source roster, the agent budgets, the taste. Making stewardship cheap is a v1
job. **Self-serve region genesis is explicitly post-v1.**

## The success ladder

Four signals, in rising order — each stage presupposes the one before:

1. **The front-page habit.** People in a region routinely *start* from
   LocalFinds to know what's happening.
2. **The moment-of-need test.** When someone needs something local right now,
   they ask — and it delivers.
3. **Community self-sufficiency.** A region thrives without its founder's daily
   involvement: local feedback tunes the agents, locals annotate the directory,
   conversation sustains itself.
4. **Pull.** A community nobody courted asks for a region.

## Evolution strategy — flexibility now, schemas at v1

The project's standing principle (exact facts in Postgres; anything fuzzy in
per-agent markdown) extends to every new domain: **while a product shape is
unproven, it lives in md/json — no new normalized schemas.** Identity contours,
per-user subscriptions, taste, community metadata all prototype soft. The
existing Postgres core (places / finds / sources / runs) stays as-is.

**The public v1 release is the deliberate rebuild**: whatever shapes survived
exploration graduate to real, normalized, optimized schemas, carrying
multi-region and identity from day one. This is a one-way gate — v1 is when the
flexibility is spent and the schema debt is paid, not incrementally before.

## Non-goals

- **Not a general feed reader.** Local media only; no door held open.
- **Not a social network with a location filter.** Geography is the community
  boundary, not a growth hack.
- **Not outreach/CRM.** The prospector stays discovery-only.
- **Not self-serve region genesis at v1.** Regions are provisioned, not
  spawned.
- **Not ad-funded.** The front page earns attention by usefulness; it does not
  sell it.
