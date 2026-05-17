from functools import lru_cache
from shared.config import BaseAppSettings, PostgresMixin, RedisMixin


class Settings(BaseAppSettings, PostgresMixin, RedisMixin):
    SERVICE_NAME: str = "channel-service"
    # POSTGRES_DB comes from docker-compose env (expected: "channel_db")


@lru_cache
def get_settings() -> Settings:
    return Settings()
