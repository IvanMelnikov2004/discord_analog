from contextlib import asynccontextmanager
from uuid import UUID

import httpx
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from livekit import api
from pydantic import BaseModel, Field

from app.config import get_settings
from shared.deps import CurrentUser, make_current_user_dependency
from shared.logging import configure_logging

settings = get_settings()
configure_logging(settings.SERVICE_NAME, settings.LOG_LEVEL)
get_current_user = make_current_user_dependency(settings.JWT_SECRET_KEY, settings.JWT_ALGORITHM)


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield


app = FastAPI(title="Media Service", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class TokenRequest(BaseModel):
    room_id: UUID
    identity: str | None = None
    # Channel that owns the room. When present, the server checks the caller's
    # mute status in that channel and disables `can_publish` if muted.
    channel_id: UUID | None = None


class TokenResponse(BaseModel):
    token: str
    url: str
    room: str
    identity: str
    # True when the issued token allows publishing (microphone). False when the
    # user is muted in the channel.
    can_publish: bool = True


async def _is_muted_in_channel(channel_id: str, auth_header: str | None) -> bool:
    """Ask channel-service whether the caller is currently muted there.

    Fail-open here (mute is a soft restriction; voice still works on errors —
    moderators can re-mute). For stricter behavior, flip to fail-closed.
    """
    if not channel_id or not auth_header:
        return False
    url = f"{settings.CHANNEL_SERVICE_URL}/api/channels/{channel_id}/me/permissions"
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            resp = await client.get(url, headers={"Authorization": auth_header})
        if resp.status_code != 200:
            return False
        return bool(resp.json().get("muted"))
    except Exception:
        return False


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/media/token", response_model=TokenResponse)
async def issue_token(
    payload: TokenRequest,
    request: Request,
    current: CurrentUser = Depends(get_current_user),
) -> TokenResponse:
    """Issue a short-lived LiveKit access token.

    If the caller is muted in the channel, the token is issued with
    can_publish=false (subscribe only). They can still hear others.
    """
    identity = payload.identity or str(current.id)
    room_name = f"room-{payload.room_id}"

    muted = await _is_muted_in_channel(
        str(payload.channel_id) if payload.channel_id else "",
        request.headers.get("Authorization"),
    )

    try:
        token = (
            api.AccessToken(settings.LIVEKIT_API_KEY, settings.LIVEKIT_API_SECRET)
            .with_identity(identity)
            .with_name(identity)
            .with_grants(
                api.VideoGrants(
                    room_join=True,
                    room=room_name,
                    can_publish=not muted,
                    can_subscribe=True,
                )
            )
            .to_jwt()
        )
    except Exception as e:
        raise HTTPException(500, f"Failed to mint token: {e}") from e

    return TokenResponse(
        token=token,
        url=settings.LIVEKIT_URL,
        room=room_name,
        identity=identity,
        can_publish=not muted,
    )
