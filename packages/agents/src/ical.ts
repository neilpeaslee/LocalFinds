// iCal (RFC 5545) parsing + feed fetch for the fetch_ical tool. Pure logic +
// HTTP only (no SDK/db imports beyond the shared ToolTextResult type), mirroring
// overpass.ts so it stays unit-testable via an injected fetchImpl.
import type { ToolTextResult } from "./overpass";

export interface ICalEvent {
  summary: string | null;
  start: string | null; // ISO 8601 wall-clock
  end: string | null;
  url: string | null;
  location: string | null;
}

export function isVCalendar(text: string): boolean {
  return /BEGIN:VCALENDAR/i.test(text);
}

// RFC 5545 line unfolding: a line starting with a space or tab continues the
// previous one (strip the single leading whitespace char).
function unfold(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (out.length && (line.startsWith(" ") || line.startsWith("\t"))) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

function unescapeText(v: string): string {
  return v.replace(/\\([\\;,nN])/g, (_, c) => (c === "n" || c === "N" ? "\n" : c));
}

// ICS datetime → ISO. Handles YYYYMMDD, YYYYMMDDTHHMMSS, and a trailing Z.
function toIso(value: string): string | null {
  const v = value.trim();
  let m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] ?? ""}`;
  m = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

export function parseICal(text: string): ICalEvent[] {
  const events: ICalEvent[] = [];
  let cur: Partial<ICalEvent> | null = null;
  for (const line of unfold(text)) {
    if (line === "BEGIN:VEVENT") {
      cur = {};
      continue;
    }
    if (line === "END:VEVENT") {
      if (cur && cur.start) {
        events.push({
          summary: cur.summary ?? null,
          start: cur.start,
          end: cur.end ?? null,
          url: cur.url ?? null,
          location: cur.location ?? null,
        });
      }
      cur = null;
      continue;
    }
    if (!cur) continue;
    const ci = line.indexOf(":");
    if (ci === -1) continue;
    const name = line.slice(0, ci).split(";")[0].toUpperCase();
    const value = line.slice(ci + 1);
    switch (name) {
      case "SUMMARY":
        cur.summary = unescapeText(value);
        break;
      case "DTSTART":
        cur.start = toIso(value);
        break;
      case "DTEND":
        cur.end = toIso(value);
        break;
      case "URL":
        cur.url = value.trim();
        break;
      case "LOCATION":
        cur.location = unescapeText(value);
        break;
    }
  }
  return events;
}

// The Events Calendar (ECP) iCal feed lives at predictable URLs. Probe the URL
// as given first, then common ECP forms derived from its origin.
export function icalCandidates(url: string): string[] {
  const out: string[] = [];
  const add = (u: string) => {
    if (u && !out.includes(u)) out.push(u);
  };
  add(url);
  try {
    const u = new URL(url);
    const withIcal = new URL(url);
    withIcal.searchParams.set("ical", "1");
    add(withIcal.toString());
    add(`${u.origin}/events/?ical=1`);
    add(`${u.origin}/?post_type=tribe_events&ical=1`);
    add(`${u.origin}/events/list/?ical=1`);
  } catch {
    // not a parseable URL — leave just the raw string
  }
  return out.slice(0, 5);
}

const ICAL_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/124.0 Safari/537.36 LocalFinds/1.0 (personal local-discovery feed)";

export type IcalFetchResult =
  | { ok: true; feedUrl: string; events: ICalEvent[] }
  | { ok: false; error: string; status?: number };

// Try each candidate; the first 2xx response whose body is a VCALENDAR wins.
export async function runIcalFetch(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<IcalFetchResult> {
  let last: IcalFetchResult = { ok: false, error: "no candidates" };
  for (const candidate of icalCandidates(url)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25_000);
    try {
      const res = await fetchImpl(candidate, {
        headers: { "User-Agent": ICAL_UA },
        redirect: "follow",
        signal: controller.signal,
      });
      if (!res.ok) {
        last = { ok: false, error: `HTTP ${res.status}`, status: res.status };
        continue;
      }
      const body = await res.text();
      if (!isVCalendar(body)) {
        last = { ok: false, error: "response was not an iCalendar feed" };
        continue;
      }
      return { ok: true, feedUrl: candidate, events: parseICal(body) };
    } catch (err) {
      last = { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  }
  return last;
}

// Project a fetch result into the fetch_ical tool's response: upcoming events
// only (start >= today, date-prefix compare), sorted ascending, capped. A failed
// fetch is flagged isError:true so it surfaces in the run's warning count.
export function formatIcalResult(
  result: IcalFetchResult,
  limit?: number,
  today: string = new Date().toISOString().slice(0, 10),
): ToolTextResult {
  if (!result.ok) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: result.error, status: result.status }) }],
      isError: true,
    };
  }
  const cap = Math.min(Math.max(limit ?? 30, 1), 60);
  const upcoming = result.events
    .filter((e): e is ICalEvent & { start: string } => !!e.start && e.start.slice(0, 10) >= today)
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  const events = upcoming.slice(0, cap);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          feedUrl: result.feedUrl,
          matched: upcoming.length,
          returned: events.length,
          truncated: upcoming.length > cap,
          events,
        }),
      },
    ],
  };
}
