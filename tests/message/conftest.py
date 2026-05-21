"""Conftest for message-service tests. Mocks Mongo and Redis at module level
before the app imports them.
"""
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "libs" / "shared-py"))
sys.path.insert(0, str(ROOT / "services" / "message-service"))

os.environ.setdefault("JWT_SECRET_KEY", "x" * 64)
os.environ.setdefault("MONGO_HOST", "localhost")
os.environ.setdefault("MONGO_USER", "test")
os.environ.setdefault("MONGO_PASSWORD", "test")
os.environ.setdefault("MONGO_DB", "test_messages")
os.environ.setdefault("REDIS_HOST", "localhost")

# Patch motor + redis BEFORE app imports
import fakeredis.aioredis  # noqa: E402
import motor.motor_asyncio  # noqa: E402
from mongomock_motor import AsyncMongoMockClient  # noqa: E402

# Replace the Motor client class so any AsyncIOMotorClient(...) call returns a mock.
motor.motor_asyncio.AsyncIOMotorClient = AsyncMongoMockClient

# Replace redis.asyncio.from_url with one returning a fake instance.
import redis.asyncio as aioredis  # noqa: E402

_fake_redis_instance = fakeredis.aioredis.FakeRedis(decode_responses=True)
aioredis.from_url = lambda *a, **kw: _fake_redis_instance  # type: ignore

# Now import the app — it'll use the mocked Motor + fake Redis.
import pytest  # noqa: E402
import pytest_asyncio  # noqa: E402
from httpx import ASGITransport, AsyncClient  # noqa: E402

from app import db as msg_db  # noqa: E402
from app import routes as msg_routes  # noqa: E402
from app.main import app  # noqa: E402


@pytest_asyncio.fixture(autouse=True)
async def clean_state():
    """Wipe the messages collection between tests."""
    await msg_db.messages_collection.delete_many({})
    yield


@pytest_asyncio.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c
