"""MongoDB client and Redis pub/sub."""
from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase
import redis.asyncio as aioredis

from app.config import get_settings

settings = get_settings()

mongo_client: AsyncIOMotorClient = AsyncIOMotorClient(settings.mongo_uri)
mongo_db: AsyncIOMotorDatabase = mongo_client[settings.MONGO_DB]
messages_collection = mongo_db["messages"]
# Sender-key envelopes: each doc is one sender's AES key, encrypted for one
# recipient via pairwise ECDH. Server only ever sees ciphertext — true E2EE.
sender_keys_collection = mongo_db["sender_keys"]

redis_pub = aioredis.from_url(settings.redis_url, decode_responses=True)


async def init_indexes() -> None:
    """Create indexes on first start. Idempotent."""
    await messages_collection.create_index([("room_id", 1), ("created_at", -1)])
    await messages_collection.create_index([("dm_pair", 1), ("created_at", -1)])
    await messages_collection.create_index("id", unique=True)
    # Recipient looks up envelopes addressed to them in a given room
    await sender_keys_collection.create_index([("room_id", 1), ("recipient_id", 1)])
    # Re-distribution overwrites: one envelope per (room, sender, recipient)
    await sender_keys_collection.create_index(
        [("room_id", 1), ("sender_id", 1), ("recipient_id", 1)], unique=True
    )

