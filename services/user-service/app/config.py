from functools import lru_cache
from shared.config import BaseAppSettings, PostgresMixin


class Settings(BaseAppSettings, PostgresMixin):
    SERVICE_NAME: str = "user-service"
    # POSTGRES_DB comes from docker-compose env (expected: "user_db")


@lru_cache
def get_settings() -> Settings:
    return Settings()
