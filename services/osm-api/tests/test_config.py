import pytest

from osm_api.config import Settings, get_settings


def test_settings_reads_required_env(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@localhost/gis")
    monkeypatch.setenv("OSM_API_TOKEN", "secret-token")
    s = get_settings()
    assert s.database_url == "postgresql://u:p@localhost/gis"
    assert s.osm_api_token == "secret-token"
    assert s.default_limit == 200
    assert s.max_limit == 1000


def test_settings_missing_required_env_raises(monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("OSM_API_TOKEN", raising=False)
    with pytest.raises(Exception):
        Settings()
