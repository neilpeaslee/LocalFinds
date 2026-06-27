import pytest

from osm_api.queries import BboxError, fetch_businesses, parse_bbox


def test_parse_bbox_ok():
    assert parse_bbox("44.05,-69.20,44.15,-69.05") == (44.05, -69.20, 44.15, -69.05)


@pytest.mark.parametrize("raw", ["1,2,3", "a,b,c,d", "44.2,-69,44.1,-68", "91,0,92,1", "44,-68,45,-69"])
def test_parse_bbox_rejects_bad(raw):
    with pytest.raises(BboxError):
        parse_bbox(raw)


async def test_fetch_by_town(pg_conn):
    rows = await fetch_businesses(
        pg_conn, town="rockland", bbox=None, keys=None, limit=100
    )
    ids = {r["osm_id"] for r in rows}
    assert ids == {"node/1", "way/2", "relation/3"}


async def test_fetch_by_town_unknown_is_empty(pg_conn):
    rows = await fetch_businesses(
        pg_conn, town="nowhere", bbox=None, keys=None, limit=100
    )
    assert rows == []


async def test_fetch_keys_filter(pg_conn):
    rows = await fetch_businesses(
        pg_conn, town="rockland", bbox=None, keys=["shop"], limit=100
    )
    assert {r["osm_id"] for r in rows} == {"way/2"}


async def test_fetch_by_bbox(pg_conn):
    rows = await fetch_businesses(
        pg_conn, town=None, bbox=(44.05, -69.20, 44.15, -69.05), keys=None, limit=100
    )
    assert {r["osm_id"] for r in rows} == {"node/1", "way/2", "relation/3"}


async def test_fetch_limit_caps(pg_conn):
    rows = await fetch_businesses(
        pg_conn, town="rockland", bbox=None, keys=None, limit=1
    )
    assert len(rows) == 1


async def test_fetch_invalid_key_raises(pg_conn):
    with pytest.raises(ValueError):
        await fetch_businesses(
            pg_conn, town="rockland", bbox=None, keys=["badkey"], limit=100
        )
    with pytest.raises(ValueError):  # mixed valid+invalid also rejected
        await fetch_businesses(
            pg_conn, town="rockland", bbox=None, keys=["shop", "badkey"], limit=100
        )


async def test_fetch_bbox_with_keys(pg_conn):
    rows = await fetch_businesses(
        pg_conn, town=None, bbox=(44.05, -69.20, 44.15, -69.05),
        keys=["shop"], limit=100,
    )
    assert {r["osm_id"] for r in rows} == {"way/2"}
