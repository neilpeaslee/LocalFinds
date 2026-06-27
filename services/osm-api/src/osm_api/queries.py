from __future__ import annotations

import asyncpg

BUSINESS_KEYS: tuple[str, ...] = (
    "amenity", "shop", "tourism", "office", "craft", "leisure",
)


class BboxError(ValueError):
    """Raised when a bbox string is malformed or out of range."""


def parse_bbox(raw: str) -> tuple[float, float, float, float]:
    parts = raw.split(",")
    if len(parts) != 4:
        raise BboxError("bbox must be 's,w,n,e' (four comma-separated numbers)")
    try:
        s, w, n, e = (float(p) for p in parts)
    except ValueError as exc:
        raise BboxError("bbox values must be numbers") from exc
    if not (-90 <= s <= 90 and -90 <= n <= 90):
        raise BboxError("bbox lat (s, n) must be within [-90, 90]")
    if not (-180 <= w <= 180 and -180 <= e <= 180):
        raise BboxError("bbox lng (w, e) must be within [-180, 180]")
    if s >= n or w >= e:
        raise BboxError("bbox must have s < n and w < e")
    return (s, w, n, e)


async def fetch_businesses(
    conn: asyncpg.Connection,
    *,
    town: str | None,
    bbox: tuple[float, float, float, float] | None,
    keys: list[str] | None,
    limit: int,
) -> list[dict]:
    where: list[str] = []
    params: list[object] = []

    if town is not None:
        params.append(town)
        where.append(f"lower(town) = lower(${len(params)})")
    elif bbox is not None:
        s, w, n, e = bbox
        # geom is 3857; build the filter envelope in 4326 and transform.
        params.extend([w, s, e, n])
        where.append(
            f"ST_Intersects(geom, ST_Transform("
            f"ST_MakeEnvelope(${len(params)-3}, ${len(params)-2}, "
            f"${len(params)-1}, ${len(params)}, 4326), 3857))"
        )
    else:  # pragma: no cover - caller guarantees exactly one
        raise ValueError("exactly one of town/bbox is required")

    if keys:
        # Validate against the allowlist and reject unknown keys outright — a
        # silent drop would turn keys=["badkey"] into "return everything".
        invalid = [k for k in keys if k not in BUSINESS_KEYS]
        if invalid:
            raise ValueError(f"unknown business key(s): {', '.join(invalid)}")
        ors = " OR ".join(f"kind LIKE '{k}=%'" for k in keys)
        where.append(f"({ors})")

    params.append(limit)
    sql = (
        "SELECT osm_id, name, lat, lng, kind, tags, address, town, "
        "website, phone, brand FROM osm_businesses WHERE "
        + " AND ".join(where)
        + f" LIMIT ${len(params)}"
    )
    rows = await conn.fetch(sql, *params)
    return [dict(r) for r in rows]
