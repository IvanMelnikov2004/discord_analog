"""WebSocket gateway.

Client protocol (JSON, both directions):
- {"op": "auth", "token": "<jwt>"}                       — first message, required
- {"op": "subscribe", "channel": "room:<uuid>"}          — subscribe to a room or DM pair
- {"op": "unsubscribe", "channel": "..."}
- {"op": "ping"}                                          — keep-alive
- Server pushes: {"type": "message.new", "data": {...}}, etc.
"""
import json
from contextlib import asynccontextmanager
from uuid import UUID

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from app.config import get_settings
from app.manager import manager
from shared.jwt_utils import decode_token
from shared.logging import configure_logging, get_logger

settings = get_settings()
configure_logging(settings.SERVICE_NAME, settings.LOG_LEVEL)
log = get_logger()


@asynccontextmanager
async def lifespan(app: FastAPI):
    await manager.startup()
    yield
    await manager.shutdown()


app = FastAPI(title="Gateway Service", lifespan=lifespan)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.websocket("/ws")
async def ws_endpoint(websocket: WebSocket) -> None:
    await websocket.accept()
    user_id: UUID | None = None

    try:
        # ---- auth handshake ----
        first = await websocket.receive_text()
        try:
            msg = json.loads(first)
        except json.JSONDecodeError:
            await websocket.close(code=4000, reason="Invalid JSON")
            return

        if msg.get("op") != "auth" or "token" not in msg:
            await websocket.close(code=4001, reason="Expected auth op")
            return
        try:
            payload = decode_token(msg["token"], settings.JWT_SECRET_KEY, settings.JWT_ALGORITHM)
        except ValueError:
            await websocket.close(code=4001, reason="Bad token")
            return
        if payload.type != "access":
            await websocket.close(code=4001, reason="Wrong token type")
            return

        user_id = UUID(payload.sub)
        await manager.register(user_id, websocket)
        # Always subscribe the connection to its own user-scoped channel —
        # this is how moderation events (mute/kick/ban/role) reach the client.
        await manager.subscribe(user_id, f"user:{user_id}")
        await websocket.send_text(
            json.dumps({"type": "auth.ok", "data": {"user_id": str(user_id)}})
        )
        log.info("ws.connected", user_id=str(user_id))

        # ---- main loop ----
        while True:
            data = await websocket.receive_text()
            try:
                msg = json.loads(data)
            except json.JSONDecodeError:
                continue

            op = msg.get("op")
            if op == "subscribe":
                ch = msg.get("channel", "")
                if isinstance(ch, str) and (
                    ch.startswith("room:")
                    or ch.startswith("dm:")
                    or ch.startswith("user:")
                    or ch.startswith("channel:")
                ):
                    await manager.subscribe(user_id, ch)
                    await websocket.send_text(
                        json.dumps({"type": "subscribed", "data": {"channel": ch}})
                    )
                    log.info("ws.subscribed", user_id=str(user_id), channel=ch)
            elif op == "unsubscribe":
                ch = msg.get("channel", "")
                if isinstance(ch, str):
                    await manager.unsubscribe(user_id, ch)
            elif op == "ping":
                await websocket.send_text(json.dumps({"type": "pong"}))
            else:
                await websocket.send_text(
                    json.dumps({"type": "error", "data": {"reason": "Unknown op"}})
                )

    except WebSocketDisconnect:
        pass
    except Exception as e:
        log.warning("ws.error", error=str(e))
    finally:
        if user_id is not None:
            await manager.disconnect(user_id, websocket)
            log.info("ws.disconnected", user_id=str(user_id))
