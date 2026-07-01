"""Integration test for the one-time SQLite→Postgres ETL.

Builds a small SQLite DB from the legacy schema, populates representative rows,
runs migrate() into the shared testcontainer, and asserts correctness.

The ETL writes to the shared session container (commits are permanent within
the session).  All assertions use a separate read connection; data is left in
place so the session container reflects a realistic post-ETL state.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import asyncpg
import pytest

# The etl package is installed from db/pyproject.toml ([tool.setuptools] packages=["etl"])
from etl.migrate_sqlite_to_pg import migrate

FIXTURES = Path(__file__).parent / "fixtures"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _build_sqlite(path: Path) -> None:
    """Create a populated legacy SQLite DB at *path*."""
    schema = (FIXTURES / "legacy_sqlite_schema.sql").read_text()
    conn = sqlite3.connect(path)
    conn.executescript(schema)

    # One source
    conn.execute(
        "INSERT INTO sources (url, name, status, finds_count, added_by, created_at) "
        "VALUES ('https://etl-test.example/feed','ETL Test Feed','active',0,'etl','2024-01-01T00:00:00')"
    )

    # Four businesses ---------------------------------------------------
    # biz1: closed → status_override='closed'
    conn.execute(
        "INSERT INTO businesses (osm_id,name,status,added_by,discovered_at,last_seen_at) "
        "VALUES ('node/201','Closed Shop','closed','etl','2024-01-01','2024-01-01')"
    )
    # biz2: active + notes_path → annotation with note
    conn.execute(
        "INSERT INTO businesses (osm_id,name,status,notes_path,added_by,discovered_at,last_seen_at) "
        "VALUES ('node/202','Noted Place','active','notes/biz202.md','etl','2024-01-01','2024-01-01')"
    )
    # biz3: active + duplicate_of → annotation with duplicate_of
    conn.execute(
        "INSERT INTO businesses (osm_id,name,status,duplicate_of,added_by,discovered_at,last_seen_at) "
        "VALUES ('node/203','Dupe Place','active','node/201','etl','2024-01-01','2024-01-01')"
    )
    # biz4: default/clean → NO annotation (unless a lead points at it)
    conn.execute(
        "INSERT INTO businesses (osm_id,name,status,added_by,discovered_at,last_seen_at) "
        "VALUES ('node/204','Clean Place','active','etl','2024-01-01','2024-01-01')"
    )
    # biz5: truly clean → NO annotation (active, no note, no dup, no lead at all)
    conn.execute(
        "INSERT INTO businesses (osm_id,name,status,added_by,discovered_at,last_seen_at) "
        "VALUES ('node/205','Truly Clean Place','active','etl','2024-01-01','2024-01-01')"
    )
    # biz6: clean, only referenced by a non-lead find (event type) → anchor must be created
    conn.execute(
        "INSERT INTO businesses (osm_id,name,status,added_by,discovered_at,last_seen_at) "
        "VALUES ('node/206','Event Venue','active','etl','2024-01-01','2024-01-01')"
    )

    # Grab ids for FK wiring
    biz1_id = conn.execute("SELECT id FROM businesses WHERE osm_id='node/201'").fetchone()[0]
    biz4_id = conn.execute("SELECT id FROM businesses WHERE osm_id='node/204'").fetchone()[0]
    biz6_id = conn.execute("SELECT id FROM businesses WHERE osm_id='node/206'").fetchone()[0]
    src_id  = conn.execute("SELECT id FROM sources").fetchone()[0]

    # Five finds --------------------------------------------------------
    # find1: lead → biz4 (clean biz, so anchor must be created)
    conn.execute(
        "INSERT INTO finds (title,url_hash,agent,discovered_at,type,business_id) "
        "VALUES ('Lead to Clean','etl-hash-1','scout','2024-01-01T00:00:00','lead'," + str(biz4_id) + ")"
    )
    # find2: event with source_id → tests source remap
    conn.execute(
        "INSERT INTO finds (title,url,url_hash,agent,discovered_at,type,source_id,tags) "
        "VALUES ('Event with Source','https://etl-test.example/e1','etl-hash-2','scout',"
        "'2024-01-01T00:00:00','event'," + str(src_id) + ",'[\"music\",\"outdoor\"]')"
    )
    # find3: lead → biz1 (closed biz already has annotation)
    conn.execute(
        "INSERT INTO finds (title,url_hash,agent,discovered_at,type,business_id) "
        "VALUES ('Lead to Closed','etl-hash-3','scout','2024-01-01T00:00:00','lead'," + str(biz1_id) + ")"
    )
    # find4: plain event, no source
    conn.execute(
        "INSERT INTO finds (title,url_hash,agent,discovered_at,type) "
        "VALUES ('Plain Event','etl-hash-4','scout','2024-01-01T00:00:00','event')"
    )
    # find5: non-lead (event) with business_id → must get anchor + place_osm_id without FK violation
    conn.execute(
        "INSERT INTO finds (title,url_hash,agent,discovered_at,type,business_id) "
        "VALUES ('Event at Venue','etl-hash-5','scout','2024-01-01T00:00:00','event'," + str(biz6_id) + ")"
    )

    find2_id = conn.execute("SELECT id FROM finds WHERE url_hash='etl-hash-2'").fetchone()[0]

    # Feedback on find2
    conn.execute(
        "INSERT INTO feedback (find_id,action,created_at) VALUES (?,?,?)",
        (find2_id, "thumbs_up", "2024-01-02T00:00:00"),
    )
    conn.execute(
        "INSERT INTO feedback (find_id,action,note,created_at) VALUES (?,?,?,?)",
        (find2_id, "star", "nice one", "2024-01-03T00:00:00"),
    )

    # One run + one fetch
    conn.execute(
        "INSERT INTO runs (agent,started_at,finished_at,status,items_added,items_updated,warnings) "
        "VALUES ('prospector','2024-01-01T01:00:00','2024-01-01T01:05:00','success',4,0,0)"
    )
    run_id = conn.execute("SELECT id FROM runs").fetchone()[0]
    conn.execute(
        "INSERT INTO fetches (run_id,agent,host,url,method,status,klass,via,ts) VALUES (?,?,?,?,?,?,?,?,?)",
        (run_id, "prospector", "etl-test.example", "https://etl-test.example/feed",
         "GET", 200, "ok", "webfetch", "2024-01-01T01:00:30"),
    )

    conn.commit()
    conn.close()


# ---------------------------------------------------------------------------
# Test
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
async def etl_counts(pg_dsn, tmp_path_factory):
    """Run the ETL once; yield the returned counts dict."""
    db_path = tmp_path_factory.mktemp("etl") / "legacy.db"
    _build_sqlite(db_path)
    return await migrate(str(db_path), pg_dsn)


@pytest.fixture
async def check(pg_dsn):
    """A read-only asyncpg connection for post-ETL assertions (function-scoped
    so it lives in the same event loop as the test function)."""
    conn = await asyncpg.connect(pg_dsn)
    yield conn
    await conn.close()


# -- count assertions -------------------------------------------------------

def test_source_count(etl_counts):
    assert etl_counts["sources"] == 1


def test_finds_count(etl_counts):
    assert etl_counts["finds"] == 5


def test_feedback_count(etl_counts):
    assert etl_counts["feedback"] == 2


def test_runs_count(etl_counts):
    assert etl_counts["runs"] == 1


def test_fetches_count(etl_counts):
    assert etl_counts["fetches"] == 1


def test_place_annotations_count(etl_counts):
    # biz1 (closed) + biz2 (noted) + biz3 (duplicate_of) + biz4 (lead anchor)
    # + biz6 (event anchor, find5) = 5
    # biz5 (node/205) is truly clean — no lead, no note, no dup — produces zero rows
    assert etl_counts["place_annotations"] == 5


# -- structural assertions --------------------------------------------------

async def test_lead_place_osm_id_set(check):
    row = await check.fetchrow(
        "SELECT place_osm_id FROM localfinds.finds WHERE url_hash='etl-hash-1'"
    )
    assert row["place_osm_id"] == "node/204"


async def test_lead_anchor_row_exists(check):
    row = await check.fetchrow(
        "SELECT osm_id FROM localfinds.place_annotations WHERE osm_id='node/204'"
    )
    assert row is not None, "anchor row for clean-biz lead must exist"


async def test_closed_business_annotation(check):
    row = await check.fetchrow(
        "SELECT status_override FROM localfinds.place_annotations WHERE osm_id='node/201'"
    )
    assert row["status_override"] == "closed"


async def test_noted_business_annotation(check):
    row = await check.fetchrow(
        "SELECT note FROM localfinds.place_annotations WHERE osm_id='node/202'"
    )
    assert row["note"] == "notes/biz202.md"


async def test_duplicate_business_annotation(check):
    row = await check.fetchrow(
        "SELECT duplicate_of FROM localfinds.place_annotations WHERE osm_id='node/203'"
    )
    assert row["duplicate_of"] == "node/201"


async def test_clean_business_no_annotation_fields(check):
    # node/204 exists as anchor only — status_override/note/duplicate_of all null
    row = await check.fetchrow(
        "SELECT status_override, note, duplicate_of "
        "FROM localfinds.place_annotations WHERE osm_id='node/204'"
    )
    assert row["status_override"] is None
    assert row["note"] is None
    assert row["duplicate_of"] is None


async def test_source_remapped_on_find(check):
    # find with url_hash='etl-hash-2' must have a non-null source_id that
    # resolves to the correct URL in localfinds.sources
    row = await check.fetchrow(
        "SELECT f.source_id, s.url "
        "FROM localfinds.finds f "
        "JOIN localfinds.sources s ON s.id = f.source_id "
        "WHERE f.url_hash = 'etl-hash-2'"
    )
    assert row is not None
    assert row["url"] == "https://etl-test.example/feed"


async def test_tags_migrated(check):
    row = await check.fetchrow(
        "SELECT tags FROM localfinds.finds WHERE url_hash='etl-hash-2'"
    )
    assert set(row["tags"]) == {"music", "outdoor"}


async def test_feedback_find_id_remapped(check):
    # Both feedback rows must point at the new find id for etl-hash-2
    new_find_id = await check.fetchval(
        "SELECT id FROM localfinds.finds WHERE url_hash='etl-hash-2'"
    )
    count = await check.fetchval(
        "SELECT COUNT(*) FROM localfinds.feedback WHERE find_id=$1", new_find_id
    )
    assert count == 2


async def test_fetch_run_id_remapped(check):
    # The single fetch must link to a valid run in localfinds.runs
    row = await check.fetchrow(
        "SELECT f.run_id, r.agent "
        "FROM localfinds.fetches f "
        "JOIN localfinds.runs r ON r.id = f.run_id "
        "WHERE f.host='etl-test.example'"
    )
    assert row is not None
    assert row["agent"] == "prospector"


async def test_lead_to_closed_biz_place_osm_id(check):
    row = await check.fetchrow(
        "SELECT place_osm_id FROM localfinds.finds WHERE url_hash='etl-hash-3'"
    )
    assert row["place_osm_id"] == "node/201"


async def test_truly_clean_business_no_annotation(check):
    # node/205: active, no notes_path, no duplicate_of, no lead pointing at it —
    # must produce ZERO place_annotations rows (the core clean-business invariant).
    row = await check.fetchrow(
        "SELECT osm_id FROM localfinds.place_annotations WHERE osm_id = 'node/205'"
    )
    assert row is None, "clean business with no lead must not produce an annotation"


async def test_non_lead_find_with_business_id_migrates(check):
    # find5 is type='event' with a business_id pointing at biz6 (node/206).
    # The ETL must not FK-violate: place_osm_id must resolve and anchor must exist.
    row = await check.fetchrow(
        "SELECT place_osm_id FROM localfinds.finds WHERE url_hash='etl-hash-5'"
    )
    assert row is not None, "event find with business_id must be migrated"
    assert row["place_osm_id"] == "node/206", "place_osm_id must resolve to biz6's osm_id"

    anchor = await check.fetchrow(
        "SELECT osm_id FROM localfinds.place_annotations WHERE osm_id='node/206'"
    )
    assert anchor is not None, "anchor row for event-find venue must exist"
