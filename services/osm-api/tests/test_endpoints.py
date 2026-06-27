import asyncpg
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from osm_api.config import get_settings
from osm_api.main import app

AUTH = {"Authorization": "Bearer secret-token"}


@pytest.fixture(autouse=True)
def _env(monkeypatch, pg_dsn):
    monkeypatch.setenv("DATABASE_URL", pg_dsn)
    monkeypatch.setenv("OSM_API_TOKEN", "secret-token")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest_asyncio.fixture
async def client(pg_dsn):
    app.state.pool = await asyncpg.create_pool(pg_dsn, min_size=1, max_size=4)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
    await app.state.pool.close()
    app.state.pool = None


async def test_health_no_auth(client):
    r = await client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


async def test_businesses_requires_token(client):
    r = await client.get("/osm/businesses?town=rockland")
    assert r.status_code == 401


async def test_businesses_by_town_returns_array(client):
    r = await client.get("/osm/businesses?town=rockland", headers=AUTH)
    assert r.status_code == 200
    body = r.json()
    assert isinstance(body, list)
    assert {b["osm_id"] for b in body} == {"node/1", "way/2", "relation/3"}
    # row shape matches the upsert contract
    cafe = next(b for b in body if b["osm_id"] == "node/1")
    assert set(cafe) == {
        "osm_id", "name", "lat", "lng", "kind", "tags",
        "address", "town", "website", "phone", "brand",
    }


async def test_businesses_unknown_town_empty(client):
    r = await client.get("/osm/businesses?town=nowhere", headers=AUTH)
    assert r.status_code == 200
    assert r.json() == []


async def test_businesses_bad_bbox_400(client):
    r = await client.get("/osm/businesses?bbox=1,2,3", headers=AUTH)
    assert r.status_code == 400


async def test_businesses_unknown_key_400(client):
    r = await client.get("/osm/businesses?town=rockland&keys=badkey", headers=AUTH)
    assert r.status_code == 400


async def test_businesses_requires_exactly_one_filter(client):
    assert (await client.get("/osm/businesses", headers=AUTH)).status_code == 400
    assert (
        await client.get(
            "/osm/businesses?town=x&bbox=44,-70,45,-69", headers=AUTH
        )
    ).status_code == 400


async def test_businesses_db_down_503(client, monkeypatch):
    async def boom(*a, **k):
        raise asyncpg.PostgresError("db gone")

    monkeypatch.setattr("osm_api.main.fetch_businesses", boom)
    r = await client.get("/osm/businesses?town=rockland", headers=AUTH)
    assert r.status_code == 503
