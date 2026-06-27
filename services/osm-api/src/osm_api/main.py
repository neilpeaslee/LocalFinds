from __future__ import annotations

from contextlib import asynccontextmanager

import asyncpg
from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse

from .auth import require_token
from .config import get_settings
from .db import close_pool, create_pool, get_pool
from .models import Business
from .queries import BboxError, fetch_businesses, parse_bbox


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Skip if a test already injected a pool.
    own_pool = getattr(app.state, "pool", None) is None
    if own_pool:
        app.state.pool = await create_pool(get_settings().database_url)
    try:
        yield
    finally:
        if own_pool and getattr(app.state, "pool", None) is not None:
            await close_pool(app.state.pool)
            app.state.pool = None


app = FastAPI(title="LocalFinds osm-api", lifespan=lifespan)


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}


@app.get("/osm/businesses", dependencies=[Depends(require_token)])
async def businesses(
    request: Request,
    town: str | None = Query(default=None),
    bbox: str | None = Query(default=None, description="'s,w,n,e' (WGS84)"),
    keys: str | None = Query(default=None, description="csv of business keys"),
    limit: int | None = Query(default=None, ge=1),
) -> list[Business]:
    if (town is None) == (bbox is None):
        raise HTTPException(400, "provide exactly one of 'town' or 'bbox'")

    parsed_bbox = None
    if bbox is not None:
        try:
            parsed_bbox = parse_bbox(bbox)
        except BboxError as exc:
            raise HTTPException(400, str(exc)) from exc

    settings = get_settings()
    effective = min(limit or settings.default_limit, settings.max_limit)
    key_list = [k.strip() for k in keys.split(",") if k.strip()] if keys else None

    pool = get_pool(request)
    try:
        async with pool.acquire() as conn:
            rows = await fetch_businesses(
                conn, town=town, bbox=parsed_bbox, keys=key_list, limit=effective
            )
    except ValueError as exc:
        # bad input surfaced by the query layer (e.g. an unknown business key)
        raise HTTPException(400, str(exc)) from exc
    except (asyncpg.PostgresError, OSError) as exc:
        raise HTTPException(503, "database unavailable") from exc

    return [Business(**r) for r in rows]


@app.exception_handler(RuntimeError)
async def _runtime_error(_request: Request, exc: RuntimeError):
    # e.g. pool not initialized
    return JSONResponse(status_code=503, content={"detail": str(exc)})
