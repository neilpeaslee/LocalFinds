-- Per-run agent transcript, moved off the filesystem .jsonl into the single
-- system of record. One row per structured RunEvent; the (run_id, seq) PK gives
-- ordered, gap-free, resumable reads for the SSE poll and the run-detail page.
-- `kind` is the RunEvent discriminant; `payload` is the event's remaining fields
-- as jsonb. The `runs` row is created first (startRun), so the FK always resolves.
CREATE TABLE localfinds.run_events (
    run_id  bigint NOT NULL REFERENCES localfinds.runs(id),
    seq     integer NOT NULL,
    t       timestamptz NOT NULL DEFAULT now(),
    kind    text NOT NULL,
    payload jsonb NOT NULL,
    PRIMARY KEY (run_id, seq)
);
