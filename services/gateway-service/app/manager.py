"""Per-instance connection registry. Cross-instance fanout goes via Redis Pub/Sub."""
import asyncio
import json
from collections import defaultdict
from uuid import UUID

from fastapi import WebSocket
import redis.asyncio as aioredis

from app.config import get_settings

settings = get_settings()


class ConnectionManager:
    def __init__(self) -> None:
        self.user_sockets: dict[UUID, set[WebSocket]] = defaultdict(set)
        self.subscriptions: dict[UUID, set[str]] = defaultdict(set)
        self.subscribers: dict[str, set[UUID]] = defaultdict(set)
        self._redis: aioredis.Redis | None = None
        self._pubsub_task: asyncio.Task | None = None
        self._pubsub: aioredis.client.PubSub | None = None
        self._lock = asyncio.Lock()

    async def startup(self) -> None:
        self._redis = aioredis.from_url(settings.redis_url, decode_responses=True)
        self._pubsub = self._redis.pubsub(ignore_subscribe_messages=True)
        # Subscribe to a keepalive channel so the pubsub connection is held open
        # and listen()/get_message() has at least one channel to read from.
        await self._pubsub.subscribe("__gateway_keepalive__")
        self._pubsub_task = asyncio.create_task(self._pubsub_loop())

    async def shutdown(self) -> None:
        if self._pubsub_task:
            self._pubsub_task.cancel()
            try:
                await self._pubsub_task
            except asyncio.CancelledError:
                pass
        if self._pubsub:
            await self._pubsub.close()
        if self._redis:
            await self._redis.close()

    async def register(self, user_id: UUID, ws: WebSocket) -> None:
        """Register an already-accepted websocket."""
        async with self._lock:
            self.user_sockets[user_id].add(ws)

    async def disconnect(self, user_id: UUID, ws: WebSocket) -> None:
        keys_to_unsub: list[str] = []
        async with self._lock:
            self.user_sockets[user_id].discard(ws)
            if not self.user_sockets[user_id]:
                del self.user_sockets[user_id]
                for sub in self.subscriptions.pop(user_id, set()):
                    self.subscribers[sub].discard(user_id)
                    if not self.subscribers[sub]:
                        del self.subscribers[sub]
                        keys_to_unsub.append(sub)
        if self._pubsub:
            for k in keys_to_unsub:
                try:
                    await self._pubsub.unsubscribe(k)
                except Exception:
                    pass

    async def subscribe(self, user_id: UUID, key: str) -> None:
        need_subscribe = False
        async with self._lock:
            self.subscriptions[user_id].add(key)
            if not self.subscribers[key]:
                need_subscribe = True
            self.subscribers[key].add(user_id)
        if need_subscribe and self._pubsub:
            await self._pubsub.subscribe(key)

    async def unsubscribe(self, user_id: UUID, key: str) -> None:
        need_unsub = False
        async with self._lock:
            self.subscriptions[user_id].discard(key)
            self.subscribers[key].discard(user_id)
            if not self.subscribers[key]:
                del self.subscribers[key]
                need_unsub = True
        if need_unsub and self._pubsub:
            try:
                await self._pubsub.unsubscribe(key)
            except Exception:
                pass

    async def send_to_user(self, user_id: UUID, payload: dict) -> None:
        sockets = list(self.user_sockets.get(user_id, set()))
        text = json.dumps(payload)
        dead: list[WebSocket] = []
        for ws in sockets:
            try:
                await ws.send_text(text)
            except Exception:
                dead.append(ws)
        for ws in dead:
            await self.disconnect(user_id, ws)

    async def _pubsub_loop(self) -> None:
        """Poll for Redis messages and fan them out to local subscribers."""
        assert self._pubsub is not None
        try:
            while True:
                message = await self._pubsub.get_message(
                    ignore_subscribe_messages=True, timeout=1.0
                )
                if message is None:
                    continue
                if message.get("type") != "message":
                    continue
                key = message["channel"]
                if key == "__gateway_keepalive__":
                    continue
                try:
                    payload = json.loads(message["data"])
                except Exception:
                    continue
                async with self._lock:
                    recipients = list(self.subscribers.get(key, set()))
                for uid in recipients:
                    await self.send_to_user(uid, payload)
        except asyncio.CancelledError:
            raise


manager = ConnectionManager()
