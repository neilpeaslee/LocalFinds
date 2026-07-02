"""One-time SQLite → Postgres ETL for LocalFinds SP1 schema.

Usage (CLI):
    cd /home/neil/Projects/LocalFinds/db
    . .venv/bin/activate
    python -m etl.migrate_sqlite_to_pg <path/to/localfinds.db> <dsn>

The DSN must point at a Postgres DB that already has all SP1 migrations applied.
Run against a COPY of the real SQLite DB; diff counts before the SP6 cutover.
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional


try:
    import asyncpg
except ImportError as exc:  # pragma: no cover
    raise SystemExit("asyncpg is required: pip install asyncpg") from exc

# Status values that the old SQLite schema can produce and that Postgres
# place_annotations.status_override permits.  Any other non-'active' value is
# coerced to 'unknown' (logged to stderr on a real run).
_ALLOWED_STATUS_OVERRIDE = {"closed", "unknown"}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _ts(val: Optional[str]) -> Optional[datetime]:
    """Parse an ISO 8601 text timestamp from SQLite into an aware datetime."""
    if not val:
        return None
    # JS agents write ISO strings with a trailing Z (e.g. 2026-06-30T11:03:50.545Z);
    # strptime has no directive for it, and the value is UTC — which is what the
    # naive branches below already assume.
    if val.endswith("Z"):
        val = val[:-1]
    for fmt in (
        "%Y-%m-%dT%H:%M:%S.%f",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d %H:%M:%S.%f",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d",
    ):
        try:
            return datetime.strptime(val, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


def _tags(val: Optional[str]) -> list[str]:
    """Parse a JSON array of tags stored as text in SQLite."""
    if not val:
        return []
    try:
        parsed = json.loads(val)
        return [str(t) for t in parsed] if isinstance(parsed, list) else []
    except (json.JSONDecodeError, TypeError):
        return []


def _jsonb_str(val: Optional[str]) -> Optional[str]:
    """Return a validated JSON string for Postgres jsonb, or None."""
    if not val:
        return None
    try:
        json.loads(val)  # validate
        return val
    except (json.JSONDecodeError, TypeError):
        return None


def _status_override(raw: Optional[str]) -> Optional[str]:
    """Map a SQLite business.status to a valid place_annotations.status_override."""
    if raw is None or raw == "active":
        return None
    if raw in _ALLOWED_STATUS_OVERRIDE:
        return raw
    # Unexpected value: coerce to 'unknown' and let the caller log it.
    return "unknown"


# ---------------------------------------------------------------------------
# Core migration
# ---------------------------------------------------------------------------

async def migrate(sqlite_path: str, dsn: str) -> dict[str, int]:
    """Migrate all data from the legacy SQLite DB into the SP1 Postgres schema.

    Returns a dict of per-table row counts: the number of rows read from SQLite
    (or, for place_annotations, the final count in Postgres after the run).
    All Postgres writes execute inside a single transaction — a mid-migration
    failure rolls back completely, making the migration safe to re-run.
    """
    # ---- read SQLite -------------------------------------------------------
    sconn = sqlite3.connect(sqlite_path)
    sconn.row_factory = sqlite3.Row
    cur = sconn.cursor()

    sources    = cur.execute("SELECT * FROM sources").fetchall()
    businesses = cur.execute("SELECT * FROM businesses").fetchall()
    runs       = cur.execute("SELECT * FROM runs").fetchall()
    finds      = cur.execute("SELECT * FROM finds").fetchall()
    feedback   = cur.execute("SELECT * FROM feedback").fetchall()
    fetches    = cur.execute("SELECT * FROM fetches").fetchall()
    sconn.close()

    # Pre-built lookups from SQLite
    biz_id_to_osm_id: dict[int, str] = {b["id"]: b["osm_id"] for b in businesses}
    src_id_to_url: dict[int, str]    = {s["id"]: s["url"] for s in sources}

    # ---- write Postgres (single atomic transaction) ------------------------
    pgconn = await asyncpg.connect(dsn)
    try:
        async with pgconn.transaction():
            # 1. sources → localfinds.sources
            src_url_to_new_id: dict[str, int] = {}
            for s in sources:
                new_id = await pgconn.fetchval(
                    """
                    INSERT INTO localfinds.sources
                        (url, name, notes_path, ical_url, status, quality_score,
                         finds_count, last_find_at, last_checked_at, added_by, created_at)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
                    RETURNING id
                    """,
                    s["url"],
                    s["name"],
                    s["notes_path"],
                    s["ical_url"],
                    s["status"] or "active",
                    s["quality_score"],
                    s["finds_count"] or 0,
                    _ts(s["last_find_at"]),
                    _ts(s["last_checked_at"]),
                    s["added_by"],
                    _ts(s["created_at"]) or datetime.now(timezone.utc),
                )
                src_url_to_new_id[s["url"]] = new_id

            # 2. runs → localfinds.runs
            old_run_to_new: dict[int, int] = {}
            for r in runs:
                new_id = await pgconn.fetchval(
                    """
                    INSERT INTO localfinds.runs
                        (agent, started_at, finished_at, status, items_added,
                         items_updated, warnings, num_turns, cost_usd, usage_json,
                         session_id, error)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)
                    RETURNING id
                    """,
                    r["agent"],
                    _ts(r["started_at"]) or datetime.now(timezone.utc),
                    _ts(r["finished_at"]),
                    r["status"] or "running",
                    r["items_added"] or 0,
                    r["items_updated"] or 0,
                    r["warnings"] or 0,
                    r["num_turns"],
                    r["cost_usd"],
                    _jsonb_str(r["usage_json"]),
                    r["session_id"],
                    r["error"],
                )
                old_run_to_new[r["id"]] = new_id

            # 3. businesses (non-default) → localfinds.place_annotations
            for b in businesses:
                needs = (
                    b["status"] != "active"
                    or b["notes_path"] is not None
                    or b["duplicate_of"] is not None
                )
                if not needs:
                    continue
                so = _status_override(b["status"])
                await pgconn.execute(
                    """
                    INSERT INTO localfinds.place_annotations
                        (osm_id, status_override, note, duplicate_of, added_by)
                    VALUES ($1,$2,$3,$4,'etl')
                    ON CONFLICT (osm_id) DO UPDATE
                        SET status_override = EXCLUDED.status_override,
                            note            = EXCLUDED.note,
                            duplicate_of    = EXCLUDED.duplicate_of
                    """,
                    b["osm_id"],
                    so,
                    b["notes_path"],   # path text becomes the note
                    b["duplicate_of"],
                )

            # 4. For every find (any type) with a business_id, ensure an anchor row
            #    exists (so the finds.place_osm_id FK can be satisfied).
            #    Business-derived annotations from step 3 take precedence via ON CONFLICT DO NOTHING.
            for f in finds:
                if f["business_id"] is not None:
                    osm_id = biz_id_to_osm_id.get(f["business_id"])
                    if osm_id:
                        await pgconn.execute(
                            """
                            INSERT INTO localfinds.place_annotations (osm_id, added_by)
                            VALUES ($1,'etl')
                            ON CONFLICT (osm_id) DO NOTHING
                            """,
                            osm_id,
                        )

            ann_count = await pgconn.fetchval(
                "SELECT COUNT(*) FROM localfinds.place_annotations"
            )

            # 5. finds → localfinds.finds
            old_find_to_new: dict[int, int] = {}
            for f in finds:
                new_src_id = None
                if f["source_id"] is not None:
                    url = src_id_to_url.get(f["source_id"])
                    if url:
                        new_src_id = src_url_to_new_id.get(url)

                place_osm_id = None
                if f["business_id"] is not None:
                    place_osm_id = biz_id_to_osm_id.get(f["business_id"])

                new_id = await pgconn.fetchval(
                    """
                    INSERT INTO localfinds.finds
                        (title, url, url_hash, summary, event_start, event_end,
                         expires_at, published_at, discovered_at, status, agent,
                         source_id, tags, score, type, place_osm_id)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
                    RETURNING id
                    """,
                    f["title"],
                    f["url"],
                    f["url_hash"],
                    f["summary"],
                    _ts(f["event_start"]),
                    _ts(f["event_end"]),
                    _ts(f["expires_at"]),
                    _ts(f["published_at"]),
                    _ts(f["discovered_at"]) or datetime.now(timezone.utc),
                    f["status"] or "new",
                    f["agent"],
                    new_src_id,
                    _tags(f["tags"]),
                    f["score"],
                    f["type"] or "event",
                    place_osm_id,
                )
                old_find_to_new[f["id"]] = new_id

            # 6. feedback → localfinds.feedback
            fb_count = 0
            for fb in feedback:
                new_find_id = old_find_to_new.get(fb["find_id"])
                if new_find_id is None:
                    continue  # orphaned feedback — skip
                await pgconn.execute(
                    """
                    INSERT INTO localfinds.feedback (find_id, action, note, created_at)
                    VALUES ($1,$2,$3,$4)
                    """,
                    new_find_id,
                    fb["action"],
                    fb["note"],
                    _ts(fb["created_at"]) or datetime.now(timezone.utc),
                )
                fb_count += 1

            # 7. fetches → localfinds.fetches
            for ft in fetches:
                new_run_id = old_run_to_new.get(ft["run_id"]) if ft["run_id"] else None
                await pgconn.execute(
                    """
                    INSERT INTO localfinds.fetches
                        (run_id, agent, host, url, method, status, klass, via, ts)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
                    """,
                    new_run_id,
                    ft["agent"],
                    ft["host"],
                    ft["url"],
                    ft["method"] or "GET",
                    ft["status"],
                    ft["klass"],
                    ft["via"] or "webfetch",
                    _ts(ft["ts"]) or datetime.now(timezone.utc),
                )

            return {
                "sources":          len(sources),
                "runs":             len(runs),
                "finds":            len(finds),
                "feedback":         fb_count,
                "fetches":          len(fetches),
                "place_annotations": ann_count,
            }
    finally:
        await pgconn.close()


# ---------------------------------------------------------------------------
# CLI entrypoint
# ---------------------------------------------------------------------------

def main() -> None:
    if len(sys.argv) != 3:  # noqa: PLR2004
        print("Usage: python -m etl.migrate_sqlite_to_pg <sqlite_path> <dsn>", file=sys.stderr)
        sys.exit(1)
    sqlite_path, dsn = sys.argv[1], sys.argv[2]
    if not Path(sqlite_path).exists():
        print(f"Error: SQLite file not found: {sqlite_path}", file=sys.stderr)
        sys.exit(1)
    counts = asyncio.run(migrate(sqlite_path, dsn))
    for table, n in counts.items():
        print(f"  {table:20s} {n}")


if __name__ == "__main__":
    main()
