import { describe, expect, it } from "vitest";
import { formatIcalResult, icalCandidates, isVCalendar, parseICal, runIcalFetch } from "./ical";

// Fixture exercises: folded continuation line, TZID datetime, VALUE=DATE all-day,
// escaped chars, an event with no DTSTART (dropped), and a VTIMEZONE (ignored).
const SAMPLE = [
  "BEGIN:VCALENDAR",
  "PRODID:-//Owls Head//ECPv6.16.3//EN",
  "BEGIN:VTIMEZONE",
  "TZID:America/New_York",
  "END:VTIMEZONE",
  "BEGIN:VEVENT",
  "SUMMARY:Camp: Pit Stop Pals\\, ages 6-9",
  "DTSTART;TZID=America/New_York:20260629T090000",
  "DTEND;TZID=America/New_York:20260629T150000",
  "LOCATION:117 Museum St\\nOwls Head\\, ME",
  "URL:https://owlshead.org/event/camp-pit-stop-pals/2026-06-29/",
  "DESCRIPTION:A long description that is folded across",
  " two physical lines into one logical value.",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "SUMMARY:All Day Open House",
  "DTSTART;VALUE=DATE:20260704",
  "URL:https://owlshead.org/event/open-house/",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "SUMMARY:Broken event with no start",
  "URL:https://owlshead.org/event/broken/",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

describe("isVCalendar", () => {
  it("detects a calendar body", () => {
    expect(isVCalendar(SAMPLE)).toBe(true);
  });
  it("rejects non-calendar text", () => {
    expect(isVCalendar("<html>403 Forbidden</html>")).toBe(false);
  });
});

describe("parseICal", () => {
  const events = parseICal(SAMPLE);

  it("drops VEVENTs with no DTSTART and ignores VTIMEZONE", () => {
    expect(events).toHaveLength(2);
  });
  it("parses a TZID datetime to ISO wall-clock", () => {
    expect(events[0].start).toBe("2026-06-29T09:00:00");
    expect(events[0].end).toBe("2026-06-29T15:00:00");
  });
  it("unescapes summary and location", () => {
    expect(events[0].summary).toBe("Camp: Pit Stop Pals, ages 6-9");
    expect(events[0].location).toBe("117 Museum St\nOwls Head, ME");
  });
  it("keeps the per-event URL", () => {
    expect(events[0].url).toBe("https://owlshead.org/event/camp-pit-stop-pals/2026-06-29/");
  });
  it("parses an all-day VALUE=DATE start", () => {
    expect(events[1].start).toBe("2026-07-04");
    expect(events[1].end).toBeNull();
  });
});

describe("icalCandidates", () => {
  it("includes the url itself plus ECP variants, deduped and capped", () => {
    const c = icalCandidates("https://owlshead.org/events/");
    expect(c[0]).toBe("https://owlshead.org/events/");
    expect(c).toContain("https://owlshead.org/?post_type=tribe_events&ical=1");
    expect(c.some((u) => u.includes("ical=1"))).toBe(true);
    expect(c.length).toBeLessThanOrEqual(5);
    expect(new Set(c).size).toBe(c.length);
  });
  it("returns just the raw url when it cannot be parsed", () => {
    expect(icalCandidates("not a url")).toEqual(["not a url"]);
  });
});

// Minimal fetch stub: maps url -> {status, body}.
function stubFetch(routes: Record<string, { status: number; body: string }>): typeof fetch {
  return (async (input: any) => {
    const url = String(input);
    const r = routes[url];
    if (!r) return { ok: false, status: 404, text: async () => "not found" } as any;
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => r.body } as any;
  }) as unknown as typeof fetch;
}

const FEED = [
  "BEGIN:VCALENDAR",
  "BEGIN:VEVENT",
  "SUMMARY:Past Event",
  "DTSTART:20200101T100000",
  "URL:https://x.org/event/past/",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "SUMMARY:Future Event",
  "DTSTART:20260704T100000",
  "URL:https://x.org/event/future/",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

describe("runIcalFetch", () => {
  it("returns the first candidate that yields a VCALENDAR", async () => {
    const fetchImpl = stubFetch({
      "https://x.org/events/": { status: 403, body: "Forbidden" },
      "https://x.org/events/?ical=1": { status: 200, body: FEED },
    });
    const r = await runIcalFetch("https://x.org/events/", fetchImpl);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.feedUrl).toBe("https://x.org/events/?ical=1");
      expect(r.events).toHaveLength(2);
    }
  });

  it("reports the last error when no candidate is a feed", async () => {
    const fetchImpl = stubFetch({}); // every url -> 404
    const r = await runIcalFetch("https://x.org/events/", fetchImpl);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(404);
    }
  });

  it("skips a 200 response whose body is not VCALENDAR and tries the next candidate", async () => {
    const fetchImpl = stubFetch({
      "https://x.org/events/": { status: 200, body: "<html>login page</html>" },
      "https://x.org/events/?ical=1": { status: 200, body: FEED },
    });
    const r = await runIcalFetch("https://x.org/events/", fetchImpl);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.feedUrl).toBe("https://x.org/events/?ical=1");
    }
  });
});

describe("formatIcalResult", () => {
  it("keeps only upcoming events, sorted, and projects fields", () => {
    const result = { ok: true as const, feedUrl: "https://x.org/events/?ical=1", events: parseICal(FEED) };
    const out = formatIcalResult(result, 30, "2026-06-21");
    const payload = JSON.parse(out.content[0].text);
    expect(out.isError).toBeUndefined();
    expect(payload.matched).toBe(1); // past event filtered out
    expect(payload.events[0].summary).toBe("Future Event");
    expect(payload.feedUrl).toBe("https://x.org/events/?ical=1");
  });

  it("flags a failed fetch as an error result", () => {
    const out = formatIcalResult({ ok: false, error: "HTTP 403", status: 403 });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content[0].text).status).toBe(403);
  });

  it("sets truncated false when matched events are at or under cap", () => {
    const result = { ok: true as const, feedUrl: "https://x.org/events/?ical=1", events: parseICal(FEED) };
    const out = formatIcalResult(result, 30, "2026-06-21");
    const payload = JSON.parse(out.content[0].text);
    expect(payload.truncated).toBe(false);
  });

  it("caps and flags truncation", () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      ["BEGIN:VEVENT", `SUMMARY:E${i}`, `DTSTART:2026070${i + 1}T100000`, "END:VEVENT"].join("\r\n"),
    ).join("\r\n");
    const body = `BEGIN:VCALENDAR\r\n${many}\r\nEND:VCALENDAR`;
    const out = formatIcalResult({ ok: true, feedUrl: "f", events: parseICal(body) }, 2, "2026-06-21");
    const payload = JSON.parse(out.content[0].text);
    expect(payload.returned).toBe(2);
    expect(payload.truncated).toBe(true);
  });
});
