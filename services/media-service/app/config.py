from functools import lru_cache
from shared.config import BaseAppSettings


class Settings(BaseAppSettings):
    SERVICE_NAME: str = "media-service"
    LIVEKIT_API_KEY: str = "devkey"
    LIVEKIT_API_SECRET: str = "devsecret"
    LIVEKIT_URL: str = "ws://localhost:7880"


@lru_cache
def get_settings() -> Settings:
    return Settings()
