async def _rows(pg_conn):
    return await pg_conn.fetch("SELECT * FROM osm_businesses ORDER BY osm_id")


async def test_view_excludes_unnamed_and_non_business(pg_conn):
    ids = {r["osm_id"] for r in await _rows(pg_conn)}
    # exactly the three business features; the bench (4) and street (5) are gone,
    # and the relation's negative polygon id -3 renders as "relation/3"
    assert ids == {"node/1", "way/2", "relation/3"}


async def test_view_osm_id_forms(pg_conn):
    rows = {r["osm_id"]: r for r in await _rows(pg_conn)}
    assert "node/1" in rows         # point -> node
    assert "way/2" in rows          # positive polygon id -> way
    assert "relation/3" in rows     # negative polygon id -> relation/<abs>


async def test_view_projects_cafe_fields(pg_conn):
    rows = {r["osm_id"]: r for r in await _rows(pg_conn)}
    cafe = rows["node/1"]
    assert cafe["name"] == "Rock City Coffee"
    assert cafe["kind"] == "amenity=cafe"
    assert abs(cafe["lat"] - 44.10) < 0.001
    assert abs(cafe["lng"] - (-69.11)) < 0.001
    assert cafe["website"] == "https://rockcity.example"
    assert cafe["phone"] == "+1-207-555-0100"
    assert cafe["brand"] == "Rock City"
    assert cafe["address"] == "316 Main Street, Rockland"
    assert cafe["town"] == "Rockland"            # level-8 wins over level-7
    assert set(cafe["tags"]) == {"cafe", "coffee_shop"}  # cuisine split + key value


async def test_view_kind_first_business_key(pg_conn):
    rows = {r["osm_id"]: r for r in await _rows(pg_conn)}
    assert rows["way/2"]["kind"] == "shop=supermarket"
    assert rows["relation/3"]["kind"] == "tourism=museum"


async def test_view_geom_is_srid_3857(pg_conn):
    srid = await pg_conn.fetchval(
        "SELECT ST_SRID(geom) FROM osm_businesses WHERE osm_id = 'node/1'"
    )
    assert srid == 3857


async def test_view_dedups_split_multipolygon_keeping_largest(pg_conn):
    # relation -3 is seeded as TWO planet_osm_polygon rows (a split multipolygon,
    # which osm2pgsql really produces). The view must collapse them to a single
    # relation/3 row, or the unique osm_id index / cartographer upsert chokes.
    rows = await pg_conn.fetch(
        "SELECT lng, lat FROM osm_businesses WHERE osm_id = 'relation/3'"
    )
    assert len(rows) == 1  # deduped, not two rows
    # ...and it keeps the LARGER part: point-on-surface near the center of the
    # bigger square (-69.107, 44.104), not the tiny part near (-69.090, 44.120).
    assert abs(rows[0]["lng"] - (-69.107)) < 0.001
    assert abs(rows[0]["lat"] - 44.104) < 0.001
