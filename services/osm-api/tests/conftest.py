from pathlib import Path

import asyncpg
import pytest
import pytest_asyncio
from testcontainers.postgres import PostgresContainer

SQL_DIR = Path(__file__).resolve().parents[1] / "sql"
SEED = Path(__file__).resolve().parent / "seed.sql"


def _to_asyncpg_dsn(url: str) -> str:
    # testcontainers yields a SQLAlchemy-style URL; asyncpg wants postgresql://
    return url.replace("postgresql+psycopg2://", "postgresql://")


@pytest.fixture(scope="session")
def pg_dsn():
    with PostgresContainer("postgis/postgis:15-3.4") as pg:
        dsn = _to_asyncpg_dsn(pg.get_connection_url())
        _load_schema(dsn)
        yield dsn


def _load_schema(dsn: str):
    import asyncio

    async def run():
        conn = await asyncpg.connect(dsn)
        try:
            for f in (
                SQL_DIR / "osm_fixture_schema.sql",
                SQL_DIR / "osm_businesses_view.sql",
                SEED,
            ):
                await conn.execute(f.read_text())
        finally:
            await conn.close()

    asyncio.run(run())


@pytest_asyncio.fixture
async def pg_conn(pg_dsn):
    conn = await asyncpg.connect(pg_dsn)
    try:
        yield conn
    finally:
        await conn.close()
