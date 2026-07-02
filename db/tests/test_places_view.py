async def test_unannotated_place_is_active(conn):
    row = await conn.fetchrow(
        "SELECT status, status_override, name FROM localfinds.places WHERE osm_id = 'node/1'"
    )
    assert row["name"] == "Rock City Coffee"   # catalog columns flow through
    assert row["status_override"] is None
    assert row["status"] == "active"           # effective status defaults to active


async def test_override_changes_effective_status(conn):
    await conn.execute(
        "INSERT INTO localfinds.place_annotations (osm_id, status_override, note) "
        "VALUES ('node/1', 'closed', 'verified closed by phone')"
    )
    row = await conn.fetchrow(
        "SELECT status, annotation_note FROM localfinds.places WHERE osm_id = 'node/1'"
    )
    assert row["status"] == "closed"
    assert row["annotation_note"] == "verified closed by phone"


async def test_lead_resolves_to_its_place_through_the_view(conn):
    await conn.execute(
        "INSERT INTO localfinds.place_annotations (osm_id, added_by) VALUES ('node/1', 'prospector')"
    )
    await conn.execute(
        "INSERT INTO localfinds.finds (title, url_hash, agent, type, place_osm_id) "
        "VALUES ('Rock City Coffee', 'lead-1', 'prospector', 'lead', 'node/1')"
    )
    name = await conn.fetchval(
        "SELECT p.name FROM localfinds.finds f "
        "JOIN localfinds.places p ON p.osm_id = f.place_osm_id "
        "WHERE f.url_hash = 'lead-1'"
    )
    assert name == "Rock City Coffee"
