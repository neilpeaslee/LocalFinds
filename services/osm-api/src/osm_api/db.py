from __future__ import annotations

import asyncpg
from fastapi import Request


async def create_pool(dsn: str) -> asyncpg.Pool:
    return await asyncpg.create_pool(dsn, min_size=1, max_size=10)


async def close_pool(pool: asyncpg.Pool) -> None:
    await pool.close()


def get_pool(request: Request) -> asyncpg.Pool:
    pool = getattr(request.app.state, "pool", None)
    if pool is None:
        raise RuntimeError("db pool not initialized")
    return pool
