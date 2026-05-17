from functools import lru_cache

from shared.config import BaseAppSettings, PostgresMixin


class Settings(BaseAppSettings, PostgresMixin):
    SERVICE_NAME: str = "auth-service"
    # POSTGRES_DB intentionally has no default — comes from docker-compose env.
    # Expected value: "auth_db"


@lru_cache
def get_settings() -> Settings:
    return Settings()
