from __future__ import annotations

import secrets

from fastapi import Header, HTTPException

from .config import get_settings


def require_token(authorization: str | None = Header(default=None)) -> None:
    expected = get_settings().osm_api_token
    prefix = "Bearer "
    if not authorization or not authorization.startswith(prefix):
        raise HTTPException(status_code=401, detail="missing bearer token")
    supplied = authorization[len(prefix):]
    if not secrets.compare_digest(supplied, expected):
        raise HTTPException(status_code=401, detail="invalid token")
