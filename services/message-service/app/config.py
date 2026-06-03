from functools import lru_cache
from shared.config import BaseAppSettings, MongoMixin, RedisMixin


class Settings(BaseAppSettings, MongoMixin, RedisMixin):
    SERVICE_NAME: str = "message-service"
    # Used to verify MANAGE_MESSAGES when deleting someone else's message.
    CHANNEL_SERVICE_URL: str = "http://channel-service:8000"

    # Sliding-window rate limits on message creation. Two windows: a short
    # anti-flood and a long anti-spam. Both are enforced per (user, scope).
    RATE_LIMIT_SHORT_MAX: int = 5
    RATE_LIMIT_SHORT_WINDOW_SECONDS: int = 5
    RATE_LIMIT_LONG_MAX: int = 30
    RATE_LIMIT_LONG_WINDOW_SECONDS: int = 60


@lru_cache
def get_settings() -> Settings:
    return Settings()
