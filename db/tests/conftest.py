import asyncio
from pathlib import Path

import asyncpg
import pytest
import pytest_asyncio
from testcontainers.postgres import PostgresContainer

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "migrations"
FIXTURES = Path(__file__).resolve().parent / "fixtures"


def _dsn(url: str) -> str:
    # testcontainers yields a SQLAlchemy-style URL; asyncpg wants postgresql://
    return url.replace("postgresql+psycopg2://", "postgresql://")


@pytest.fixture(scope="session")
def pg_dsn():
    with PostgresContainer("postgis/postgis:15-3.4") as pg:
        dsn = _dsn(pg.get_connection_url())
        asyncio.run(_setup(dsn))
        yield dsn


async def _setup(dsn: str):
    conn = await asyncpg.connect(dsn)
    try:
        files = [FIXTURES / "planet_osm.sql"]
        seed = FIXTURES / "seed_osm.sql"
        if seed.exists():
            files.append(seed)
        files += sorted(MIGRATIONS.glob("*.sql"))
        for f in files:
            # asyncpg.execute runs multi-statement scripts (simple query protocol)
            await conn.execute(f.read_text())
    finally:
        await conn.close()


@pytest_asyncio.fixture
async def conn(pg_dsn):
    c = await asyncpg.connect(pg_dsn)
    tx = c.transaction()
    await tx.start()
    try:
        yield c
    finally:
        await tx.rollback()
        await c.close()
