from __future__ import annotations

from pydantic import BaseModel


class Business(BaseModel):
    osm_id: str
    name: str | None
    lat: float | None
    lng: float | None
    kind: str | None
    tags: list[str] = []
    address: str | None
    town: str | None
    website: str | None
    phone: str | None
    brand: str | None
