import pytest
from fastapi import HTTPException

from osm_api.auth import require_token
from osm_api.config import get_settings


@pytest.fixture(autouse=True)
def _token_env(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@localhost/gis")
    monkeypatch.setenv("OSM_API_TOKEN", "secret-token")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def test_require_token_accepts_matching_bearer():
    require_token(authorization="Bearer secret-token")  # no raise


@pytest.mark.parametrize("header", [None, "secret-token", "Bearer wrong", "Basic x"])
def test_require_token_rejects(header):
    with pytest.raises(HTTPException) as exc:
        require_token(authorization=header)
    assert exc.value.status_code == 401
