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


class SavepointConnection:
    """Wrapper around asyncpg.Connection that uses savepoints for each operation.

    This allows tests to continue executing after an error is caught,
    since errors only rollback the savepoint, not the entire transaction.
    """

    def __init__(self, conn):
        self._conn = conn

    async def execute(self, query, *args):
        async with self._conn.transaction():
            return await self._conn.execute(query, *args)

    async def fetchval(self, query, *args):
        async with self._conn.transaction():
            return await self._conn.fetchval(query, *args)

    async def fetchrow(self, query, *args):
        async with self._conn.transaction():
            return await self._conn.fetchrow(query, *args)

    def __getattr__(self, name):
        return getattr(self._conn, name)


@pytest_asyncio.fixture
async def conn(pg_dsn):
    c = await asyncpg.connect(pg_dsn)
    tx = c.transaction()
    await tx.start()
    try:
        yield SavepointConnection(c)
    finally:
        await tx.rollback()
        await c.close()
