// Durability for the INTERACTIVE interview path only. Each ask/answer is written
// to a gitignored JSON-lines file the moment it happens, so a mid-interview
// Ctrl-C loses nothing: re-running replays the journal into a resume seed.
//
// We deliberately use journal-replay over the SDK's native session resume
// (options.resume + session_id) for two reasons: (1) portability to a future web
// surface, which won't share the CLI's on-disk session store, and (2) we run the
// interviewer with settingSources:[] / no CLI session storage, so there's no
// native session to resume anyway.
//
// The prepared path needs none of this — its questionnaire.md file IS the durable
// state.

import fs from "node:fs";
import path from "node:path";
import { agentWorkspaceDir } from "@localfinds/db";

export type JournalRole = "agent" | "user" | "system";

export interface JournalEntry {
  /** Who produced this line. */
  role: JournalRole;
  /** "ask" (agent question), "answer" (user reply), "say" (agent message), etc. */
  kind: string;
  text: string;
}

export function journalPath(): string {
  return path.join(agentWorkspaceDir("interviewer"), "session.jsonl");
}

// Append one entry, flushed synchronously: the answer is on disk BEFORE io.ask
// returns, so a crash between answering and the next turn can't lose it.
export function appendEntry(entry: JournalEntry): void {
  const file = journalPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
}

// Ordered entries, or [] if there's no journal. A malformed line is skipped
// rather than aborting the read, so a partially-flushed last line never blocks a
// resume.
export function readJournal(): JournalEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(journalPath(), "utf8");
  } catch {
    return [];
  }
  const entries: JournalEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed.text === "string") entries.push(parsed as JournalEntry);
    } catch {
      // partial/corrupt line — skip it
    }
  }
  return entries;
}

// Archive a completed interview's journal into runs/ instead of deleting it, so
// the transcript survives for later review — other agents keep runs/<id>.jsonl
// the same way. Moving (not copying) clears the live session.jsonl in the same
// step, so the next interview still starts fresh. The caller supplies a unique
// name (interview.ts uses a timestamp) to keep this deterministic and testable.
// Returns the archived path, or null if there was no journal to archive.
export function archiveJournal(name: string): string | null {
  const src = journalPath();
  if (!fs.existsSync(src)) return null;
  const dest = path.join(agentWorkspaceDir("interviewer"), "runs", `${name}.jsonl`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(src, dest);
  return dest;
}

// Render the whole conversation as plain text to hand to the synthesis phase:
// every question, answer, and interviewer note, in order. Unlike
// summarizeForResume (which keeps only un-written Q/A pairs to avoid re-asking),
// this preserves the full picture — including the user's brain-dumps and the
// agent's reflections — so the config-writing pass works from everything said.
export function renderTranscript(entries: JournalEntry[]): string {
  return entries
    .map((e) => {
      if (e.kind === "ask") return `Q: ${e.text}`;
      if (e.kind === "answer") return `A: ${e.text}`;
      if (e.kind === "say") return `(interviewer note) ${e.text}`;
      return e.text;
    })
    .join("\n");
}

// Compact the journal into a transcript seeded into a resumed run. The structured
// config that was already written persists in its files (the readers pick it up),
// so the ONLY state living solely here is the un-written question/answer pairs —
// they must survive into the seed verbatim so the agent doesn't re-ask them.
// Pure function (no I/O) so it's trivially testable.
export function summarizeForResume(entries: JournalEntry[]): string {
  const pairs: { q: string; a: string }[] = [];
  let pendingQuestion: string | null = null;
  for (const e of entries) {
    if (e.kind === "ask") {
      pendingQuestion = e.text;
    } else if (e.kind === "answer") {
      pairs.push({ q: pendingQuestion ?? "(earlier question)", a: e.text });
      pendingQuestion = null;
    }
  }
  if (pairs.length === 0) return "";
  const lines = pairs.map((p) => `Q: ${p.q}\nA: ${p.a}`);
  return [
    "## Resuming an interrupted interview",
    "You already asked the user these questions and recorded these answers.",
    "Do NOT re-ask them — continue from where you left off, and call",
    "read_current_config to see what's already been written to disk.",
    "",
    ...lines,
  ].join("\n");
}
