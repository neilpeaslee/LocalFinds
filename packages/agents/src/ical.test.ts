import { describe, expect, it } from "vitest";
import { icalCandidates, isVCalendar, parseICal } from "./ical";

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
