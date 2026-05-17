"""Base settings shared across all services."""
from pydantic_settings import BaseSettings, SettingsConfigDict


class BaseAppSettings(BaseSettings):
    """Common settings used by every service."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    SERVICE_NAME: str = "service"
    ENVIRONMENT: str = "development"
    LOG_LEVEL: str = "INFO"

    JWT_SECRET_KEY: str
    JWT_ALGORITHM: str = "HS256"
    JWT_ACCESS_TOKEN_EXPIRE_MINUTES: int = 30
    JWT_REFRESH_TOKEN_EXPIRE_DAYS: int = 14

    CORS_ORIGINS: str = "http://localhost"

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]


class PostgresMixin(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore", case_sensitive=False)

    POSTGRES_HOST: str = "postgres"
    POSTGRES_PORT: int = 5432
    POSTGRES_USER: str = "messenger"
    POSTGRES_PASSWORD: str = "messenger"
    # POSTGRES_DB has NO default on purpose — each service must set it
    # explicitly via env so migrations never silently target the wrong DB.
    POSTGRES_DB: str

    def postgres_dsn(self, db_name: str | None = None) -> str:
        db = db_name or self.POSTGRES_DB
        return (
            f"postgresql+asyncpg://{self.POSTGRES_USER}:{self.POSTGRES_PASSWORD}"
            f"@{self.POSTGRES_HOST}:{self.POSTGRES_PORT}/{db}"
        )


class MongoMixin(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore", case_sensitive=False)

    MONGO_HOST: str = "mongo"
    MONGO_PORT: int = 27017
    MONGO_USER: str = "messenger"
    MONGO_PASSWORD: str = "messenger"
    MONGO_DB: str = "messenger_messages"

    @property
    def mongo_uri(self) -> str:
        return (
            f"mongodb://{self.MONGO_USER}:{self.MONGO_PASSWORD}"
            f"@{self.MONGO_HOST}:{self.MONGO_PORT}/?authSource=admin"
        )


class RedisMixin(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore", case_sensitive=False)

    REDIS_HOST: str = "redis"
    REDIS_PORT: int = 6379
    REDIS_PASSWORD: str = ""

    @property
    def redis_url(self) -> str:
        auth = f":{self.REDIS_PASSWORD}@" if self.REDIS_PASSWORD else ""
        return f"redis://{auth}{self.REDIS_HOST}:{self.REDIS_PORT}/0"
