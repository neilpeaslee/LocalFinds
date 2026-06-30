import json


async def _ids(conn):
    rows = await conn.fetch("SELECT osm_id FROM osm_places ORDER BY osm_id")
    return {r["osm_id"] for r in rows}


async def test_includes_only_named_business_features(conn):
    # the bench (unnamed) and the street (no business key) are excluded;
    # the negative polygon id -3 renders as relation/3
    assert await _ids(conn) == {
        "node/1", "way/2", "relation/3",
        "node/10", "node/11", "way/12", "relation/6",
    }


async def test_osm_id_forms(conn):
    ids = await _ids(conn)
    assert "node/1" in ids       # point -> node
    assert "way/2" in ids        # positive polygon -> way
    assert "relation/3" in ids   # negative polygon -> relation/<abs>


async def test_cafe_projection(conn):
    row = await conn.fetchrow("SELECT * FROM osm_places WHERE osm_id = 'node/1'")
    assert row["name"] == "Rock City Coffee"
    assert row["kind"] == "amenity=cafe"
    assert row["town"] == "Rockland"
    assert row["brand"] == "Rock City"
    assert row["website"] == "https://rockcity.example"
    assert row["phone"] == "+1-207-555-0100"
    assert row["address"] == "316 Main Street, Rockland"
    assert abs(row["lat"] - 44.10) < 0.001
    assert abs(row["lng"] - (-69.11)) < 0.001
    assert await conn.fetchval(
        "SELECT ST_GeometryType(point) FROM osm_places WHERE osm_id = 'node/1'"
    ) == "ST_Point"


async def test_tags_are_full_jsonb(conn):
    raw = await conn.fetchval("SELECT tags FROM osm_places WHERE osm_id = 'node/1'")
    tags = json.loads(raw)
    # the WHOLE tag set is carried, not a capped chip array
    assert tags["amenity"] == "cafe"
    assert tags["cuisine"] == "coffee_shop"
    assert tags["brand"] == "Rock City"
    assert tags["addr:street"] == "Main Street"


async def test_way_keeps_real_polygon_geom(conn):
    row = await conn.fetchrow(
        "SELECT kind, ST_GeometryType(geom) AS g, ST_GeometryType(point) AS p "
        "FROM osm_places WHERE osm_id = 'way/2'"
    )
    assert row["kind"] == "shop=supermarket"
    assert row["g"] == "ST_Polygon"   # real shape retained
    assert row["p"] == "ST_Point"     # representative point


async def test_relation_kind(conn):
    assert await conn.fetchval(
        "SELECT kind FROM osm_places WHERE osm_id = 'relation/3'"
    ) == "tourism=museum"


async def test_all_six_business_keys_project_kind(conn):
    rows = {r["osm_id"]: r["kind"] for r in await conn.fetch("SELECT osm_id, kind FROM osm_places")}
    assert rows["node/1"] == "amenity=cafe"
    assert rows["way/2"] == "shop=supermarket"
    assert rows["relation/3"] == "tourism=museum"
    assert rows["node/10"] == "office=lawyer"
    assert rows["node/11"] == "craft=sawmill"
    assert rows["way/12"] == "leisure=park"


async def test_multipolygon_split_collapses_to_one_row(conn):
    # osm_id -6 was seeded as TWO planet_osm_polygon parts; the matview must
    # collapse them to a single relation/6 row (largest part wins).
    n = await conn.fetchval("SELECT count(*) FROM osm_places WHERE osm_id = 'relation/6'")
    assert n == 1
