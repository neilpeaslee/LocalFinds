from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Service configuration, entirely env-driven (no secrets in git)."""

    model_config = SettingsConfigDict(env_file=None, extra="ignore")

    database_url: str
    osm_api_token: str
    default_limit: int = 200
    max_limit: int = 1000


@lru_cache
def get_settings() -> Settings:
    return Settings()
