from functools import lru_cache
from shared.config import BaseAppSettings, MongoMixin, RedisMixin


class Settings(BaseAppSettings, MongoMixin, RedisMixin):
    SERVICE_NAME: str = "message-service"
    # Used to verify MANAGE_MESSAGES when deleting someone else's message.
    CHANNEL_SERVICE_URL: str = "http://channel-service:8000"


@lru_cache
def get_settings() -> Settings:
    return Settings()
