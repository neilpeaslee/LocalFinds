async def test_container_boots_and_postgis_present(conn):
    one = await conn.fetchval("SELECT 1")
    assert one == 1
    # PostGIS is available in the image the migrations target
    ext = await conn.fetchval("SELECT extname FROM pg_extension WHERE extname = 'postgis'")
    assert ext == "postgis"
