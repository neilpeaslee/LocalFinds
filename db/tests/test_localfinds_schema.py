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


async def test_users_email_unique_case_insensitive(conn):
    await conn.execute(
        "INSERT INTO localfinds.users (email, hashed_password, role)"
        " VALUES ('a@b.c', 'x', 'steward')"
    )
    with pytest.raises(asyncpg.UniqueViolationError):
        await conn.execute(
            "INSERT INTO localfinds.users (email, hashed_password) VALUES ('A@B.C', 'y')"
        )


async def test_users_role_check_rejects_bad_value(conn):
    with pytest.raises(asyncpg.CheckViolationError):
        await conn.execute(
            "INSERT INTO localfinds.users (email, hashed_password, role)"
            " VALUES ('r@b.c', 'x', 'admin')"
        )


async def test_users_role_defaults_to_member(conn):
    await conn.execute(
        "INSERT INTO localfinds.users (email, hashed_password) VALUES ('d@b.c', 'x')"
    )
    row = await conn.fetchrow("SELECT role FROM localfinds.users WHERE email = 'd@b.c'")
    assert row["role"] == "member"


async def test_users_tokens_cascade_on_user_delete(conn):
    uid = await conn.fetchval(
        "INSERT INTO localfinds.users (email, hashed_password) VALUES ('t@b.c', 'x')"
        " RETURNING id"
    )
    await conn.execute(
        "INSERT INTO localfinds.users_tokens (user_id, token, context)"
        " VALUES ($1, 'tok', 'session')",
        uid,
    )
    await conn.execute("DELETE FROM localfinds.users WHERE id = $1", uid)
    assert await conn.fetchval("SELECT count(*) FROM localfinds.users_tokens") == 0


async def test_users_tokens_context_token_unique(conn):
    uid = await conn.fetchval(
        "INSERT INTO localfinds.users (email, hashed_password) VALUES ('u@b.c', 'x')"
        " RETURNING id"
    )
    await conn.execute(
        "INSERT INTO localfinds.users_tokens (user_id, token, context)"
        " VALUES ($1, 'dup', 'session')",
        uid,
    )
    with pytest.raises(asyncpg.UniqueViolationError):
        await conn.execute(
            "INSERT INTO localfinds.users_tokens (user_id, token, context)"
            " VALUES ($1, 'dup', 'session')",
            uid,
        )
