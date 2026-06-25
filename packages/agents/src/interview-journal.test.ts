import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendEntry,
  archiveJournal,
  journalPath,
  readJournal,
  renderTranscript,
  summarizeForResume,
} from "./interview-journal";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "localfinds-journal-"));
  process.env.LOCALFINDS_DATA_DIR = dir;
});

afterEach(() => {
  delete process.env.LOCALFINDS_DATA_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("appendEntry / readJournal", () => {
  it("writes one durable JSON line, flushed before the call returns", () => {
    appendEntry({ role: "user", kind: "answer", text: "Websites for restaurants." });
    // No await — the line must already be on disk synchronously.
    const raw = fs.readFileSync(journalPath(), "utf8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      role: "user",
      kind: "answer",
      text: "Websites for restaurants.",
    });
  });

  it("appends entries as separate lines and reads them back in order", () => {
    appendEntry({ role: "agent", kind: "ask", text: "What do you sell?" });
    appendEntry({ role: "user", kind: "answer", text: "Websites." });
    appendEntry({ role: "agent", kind: "say", text: "Got it." });
    const entries = readJournal();
    expect(entries.map((e) => e.kind)).toEqual(["ask", "answer", "say"]);
    expect(entries[1].text).toBe("Websites.");
  });

  it("returns an empty array when no journal exists", () => {
    expect(readJournal()).toEqual([]);
  });

  it("skips a malformed line rather than throwing", () => {
    appendEntry({ role: "user", kind: "answer", text: "ok" });
    fs.appendFileSync(journalPath(), "{ not valid json\n");
    appendEntry({ role: "user", kind: "answer", text: "still here" });
    const entries = readJournal();
    expect(entries).toHaveLength(2);
    expect(entries[1].text).toBe("still here");
  });
});

describe("archiveJournal", () => {
  it("moves a completed journal into runs/ so the transcript survives and the next interview starts fresh", () => {
    appendEntry({ role: "agent", kind: "ask", text: "What do you sell?" });
    appendEntry({ role: "user", kind: "answer", text: "Websites." });

    const archived = archiveJournal("2026-06-24_run");

    // The live journal is gone, so the next interview won't resume this one.
    expect(fs.existsSync(journalPath())).toBe(false);
    expect(readJournal()).toEqual([]);
    // ...but the transcript survives under runs/ for later review.
    expect(archived).not.toBeNull();
    expect(archived).toContain(path.join("runs", "2026-06-24_run.jsonl"));
    const lines = fs.readFileSync(archived as string, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1])).toMatchObject({ kind: "answer", text: "Websites." });
  });

  it("returns null and does not throw when there is no journal", () => {
    expect(archiveJournal("whatever")).toBeNull();
  });
});

describe("renderTranscript", () => {
  it("renders the full conversation in order, labeling questions, answers, and interviewer notes", () => {
    const transcript = renderTranscript([
      { role: "agent", kind: "ask", text: "What do you sell?" },
      { role: "user", kind: "answer", text: "Websites and AI help." },
      { role: "agent", kind: "say", text: "So web is your lead offer." },
      { role: "agent", kind: "ask", text: "Which towns?" },
      { role: "user", kind: "answer", text: "Rockland and Camden." },
    ]);
    expect(transcript).toBe(
      [
        "Q: What do you sell?",
        "A: Websites and AI help.",
        "(interviewer note) So web is your lead offer.",
        "Q: Which towns?",
        "A: Rockland and Camden.",
      ].join("\n"),
    );
  });

  it("returns an empty string for an empty journal", () => {
    expect(renderTranscript([])).toBe("");
  });
});

describe("summarizeForResume", () => {
  it("pairs each question with its answer so the resumed agent doesn't re-ask", () => {
    const summary = summarizeForResume([
      { role: "agent", kind: "ask", text: "What do you sell?" },
      { role: "user", kind: "answer", text: "Websites for restaurants." },
      { role: "agent", kind: "ask", text: "Which towns?" },
      { role: "user", kind: "answer", text: "Rockland and Camden." },
    ]);
    // The un-written answers are the only state living solely in the journal —
    // they must survive into the resume seed.
    expect(summary).toContain("Websites for restaurants.");
    expect(summary).toContain("Rockland and Camden.");
    expect(summary).toContain("What do you sell?");
    expect(summary).toContain("Which towns?");
  });

  it("preserves a trailing answer that has no following question", () => {
    const summary = summarizeForResume([
      { role: "agent", kind: "ask", text: "Disqualifiers?" },
      { role: "user", kind: "answer", text: "National chains." },
    ]);
    expect(summary).toContain("National chains.");
  });

  it("returns an empty string for an empty journal", () => {
    expect(summarizeForResume([]).trim()).toBe("");
  });
});
