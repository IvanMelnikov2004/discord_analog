from functools import lru_cache
from shared.config import BaseAppSettings, RedisMixin


class Settings(BaseAppSettings, RedisMixin):
    SERVICE_NAME: str = "gateway-service"
    MESSAGE_SERVICE_URL: str = "http://message-service:8000"


@lru_cache
def get_settings() -> Settings:
    return Settings()
