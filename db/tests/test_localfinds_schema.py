import asyncpg
import pytest


async def _insert_find(conn, **over):
    cols = {"title": "t", "url_hash": "h-default", "agent": "scout"}
    cols.update(over)
    keys = ", ".join(cols)
    ph = ", ".join(f"${i + 1}" for i in range(len(cols)))
    await conn.execute(
        f"INSERT INTO localfinds.finds ({keys}) VALUES ({ph})", *cols.values()
    )


async def test_sources_url_is_unique(conn):
    await conn.execute(
        "INSERT INTO localfinds.sources (url, added_by) VALUES ('http://a', 'me')"
    )
    with pytest.raises(asyncpg.UniqueViolationError):
        await conn.execute(
            "INSERT INTO localfinds.sources (url, added_by) VALUES ('http://a', 'me')"
        )


async def test_finds_url_hash_is_unique(conn):
    await _insert_find(conn, url_hash="dup")
    with pytest.raises(asyncpg.UniqueViolationError):
        await _insert_find(conn, url_hash="dup", title="other")


async def test_finds_status_check_rejects_bad_value(conn):
    with pytest.raises(asyncpg.CheckViolationError):
        await _insert_find(conn, url_hash="bad-status", status="bogus")


async def test_finds_defaults(conn):
    await _insert_find(conn, url_hash="defaults")
    row = await conn.fetchrow(
        "SELECT status, type, tags FROM localfinds.finds WHERE url_hash = 'defaults'"
    )
    assert row["status"] == "new"
    assert row["type"] == "event"
    assert list(row["tags"]) == []


async def test_lead_fk_rejects_orphan_place(conn):
    # a lead pointing at a place with no annotation row is rejected
    with pytest.raises(asyncpg.ForeignKeyViolationError):
        await _insert_find(conn, url_hash="orphan-lead", type="lead", place_osm_id="node/999")


async def test_lead_with_anchor_is_accepted(conn):
    # once the anchor exists, the lead is accepted and links to it
    await conn.execute(
        "INSERT INTO localfinds.place_annotations (osm_id) VALUES ('node/1')"
    )
    await _insert_find(conn, url_hash="ok-lead", type="lead", place_osm_id="node/1")
    got = await conn.fetchval(
        "SELECT place_osm_id FROM localfinds.finds WHERE url_hash = 'ok-lead'"
    )
    assert got == "node/1"


async def test_feedback_fk_requires_a_find(conn):
    with pytest.raises(asyncpg.ForeignKeyViolationError):
        await conn.execute(
            "INSERT INTO localfinds.feedback (find_id, action) VALUES (999999, 'star')"
        )


async def test_feedback_action_check(conn):
    await _insert_find(conn, url_hash="for-feedback")
    fid = await conn.fetchval(
        "SELECT id FROM localfinds.finds WHERE url_hash = 'for-feedback'"
    )
    with pytest.raises(asyncpg.CheckViolationError):
        await conn.execute(
            "INSERT INTO localfinds.feedback (find_id, action) VALUES ($1, 'shrug')", fid
        )


async def test_run_events_fk_requires_a_run(conn):
    # a transcript row for a non-existent run is rejected
    with pytest.raises(asyncpg.ForeignKeyViolationError):
        await conn.execute(
            "INSERT INTO localfinds.run_events (run_id, seq, kind, payload) "
            "VALUES (999999, 0, 'run_start', '{}'::jsonb)"
        )


async def test_run_events_pk_rejects_duplicate_seq(conn):
    # (run_id, seq) is the primary key — the same seq twice in one run is rejected
    run_id = await conn.fetchval(
        "INSERT INTO localfinds.runs (agent) VALUES ('scout') RETURNING id"
    )
    await conn.execute(
        "INSERT INTO localfinds.run_events (run_id, seq, kind, payload) "
        "VALUES ($1, 0, 'run_start', '{}'::jsonb)",
        run_id,
    )
    with pytest.raises(asyncpg.UniqueViolationError):
        await conn.execute(
            "INSERT INTO localfinds.run_events (run_id, seq, kind, payload) "
            "VALUES ($1, 0, 'assistant_text', '{}'::jsonb)",
            run_id,
        )
