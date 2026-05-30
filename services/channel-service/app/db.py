from collections.abc import AsyncGenerator

import redis.asyncio as aioredis
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.config import get_settings

settings = get_settings()
engine = create_async_engine(settings.postgres_dsn(), pool_pre_ping=True)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False)

# Redis publisher: used to fan-out moderation events (mute/kick/ban/role
# changes) to individual users' WebSocket channels (`user:<uuid>`).
redis_pub = aioredis.from_url(settings.redis_url, decode_responses=True)


class Base(DeclarativeBase):
    pass


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with SessionLocal() as s:
        yield s
