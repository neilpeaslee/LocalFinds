import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendEntry,
  clearJournal,
  journalPath,
  readJournal,
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

describe("clearJournal", () => {
  it("removes the journal so a completed interview starts fresh next time", () => {
    appendEntry({ role: "user", kind: "answer", text: "x" });
    expect(fs.existsSync(journalPath())).toBe(true);
    clearJournal();
    expect(readJournal()).toEqual([]);
  });

  it("is a no-op when there is no journal", () => {
    expect(() => clearJournal()).not.toThrow();
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
