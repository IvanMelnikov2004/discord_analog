from functools import lru_cache
from shared.config import BaseAppSettings, MongoMixin, RedisMixin


class Settings(BaseAppSettings, MongoMixin, RedisMixin):
    SERVICE_NAME: str = "message-service"


@lru_cache
def get_settings() -> Settings:
    return Settings()
