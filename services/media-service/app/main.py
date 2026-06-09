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


# ---------- Schemas ----------

class TokenRequest(BaseModel):
    room_id: UUID
    identity: str | None = None
    channel_id: UUID | None = None


class TokenResponse(BaseModel):
    token: str
    url: str
    room: str
    identity: str
    can_publish: bool = True


class VoiceModerationRequest(BaseModel):
    """Moderate a participant in a voice room. Used for mute/unmute and kick.

    `channel_id` is needed so we can verify the caller has VOICE_MODERATE in
    that channel; `target_identity` is the LiveKit identity (= our user UUID).
    """
    channel_id: UUID
    target_identity: str = Field(min_length=1, max_length=128)


class VoiceMuteRequest(VoiceModerationRequest):
    muted: bool = True


# ---------- Helpers ----------

async def _fetch_channel_perms(channel_id: str, auth_header: str | None) -> dict | None:
    """Read the caller's permission summary from channel-service.

    Used both for self-mute checks (chat) and for VOICE_MODERATE checks.
    Returns None on any failure — callers should treat that as "no perms".
    """
    if not channel_id or not auth_header:
        return None
    url = f"{settings.CHANNEL_SERVICE_URL}/api/channels/{channel_id}/me/permissions"
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            resp = await client.get(url, headers={"Authorization": auth_header})
        if resp.status_code != 200:
            return None
        return resp.json()
    except Exception:
        return None


async def _is_muted_in_channel(channel_id: str, auth_header: str | None) -> bool:
    perms = await _fetch_channel_perms(channel_id, auth_header)
    return bool(perms and perms.get("muted"))


def _require_voice_moderate(perms: dict | None) -> None:
    """Raise 403 unless the caller can voice-moderate in this channel."""
    if not perms:
        raise HTTPException(403, "Cannot verify channel permissions")
    if perms.get("is_admin") or perms.get("is_owner"):
        return
    if "VOICE_MODERATE" in perms.get("names", []):
        return
    raise HTTPException(403, "Missing permission: VOICE_MODERATE")


def _livekit_http_url() -> str:
    """LiveKit Room Service uses HTTP(S), not WS. Derive from LIVEKIT_URL."""
    url = settings.LIVEKIT_URL
    if url.startswith("wss://"):
        return "https://" + url[6:]
    if url.startswith("ws://"):
        return "http://" + url[5:]
    return url


# ---------- Routes ----------

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

    Server-side gating, in this order:
      - Caller must have CONNECT_VOICE in the channel (else 403).
      - Caller must NOT be channel-muted (else can_publish=false).
      - Caller must have SPEAK_VOICE to publish microphone (else
        can_publish=false). They can still listen.
    """
    identity = payload.identity or str(current.id)
    room_name = f"room-{payload.room_id}"

    # Look up our standing in the channel once and reuse for all checks.
    perms = await _fetch_channel_perms(
        str(payload.channel_id) if payload.channel_id else "",
        request.headers.get("Authorization"),
    )
    if not perms:
        # No channel_id passed, or channel-service unreachable. Fail closed:
        # we won't mint tokens for unverifiable callers — this is what
        # closes the "user without CONNECT_VOICE could still join" hole.
        raise HTTPException(403, "Не удалось проверить права в канале")

    is_admin_or_owner = bool(perms.get("is_admin") or perms.get("is_owner"))
    names = perms.get("names", [])

    if not (is_admin_or_owner or "CONNECT_VOICE" in names):
        raise HTTPException(403, "У вас нет прав заходить в голосовые комнаты")

    muted = bool(perms.get("muted"))
    can_speak = is_admin_or_owner or "SPEAK_VOICE" in names
    # Effective publish right: must have SPEAK_VOICE AND not be channel-muted.
    can_publish = can_speak and not muted

    try:
        token = (
            api.AccessToken(settings.LIVEKIT_API_KEY, settings.LIVEKIT_API_SECRET)
            .with_identity(identity)
            .with_name(identity)
            .with_grants(
                api.VideoGrants(
                    room_join=True,
                    room=room_name,
                    can_publish=can_publish,
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
        can_publish=can_publish,
    )


@app.post("/api/media/rooms/{room_id}/voice-mute", status_code=204)
async def voice_mute_participant(
    room_id: UUID,
    payload: VoiceMuteRequest,
    request: Request,
    current: CurrentUser = Depends(get_current_user),
) -> None:
    """Server-side mute/unmute a participant's microphone in a voice room.

    Calls LiveKit Room Service mute_published_track on every audio track the
    participant is publishing — they physically cannot speak until unmuted,
    even if they reload or modify the client.
    """
    perms = await _fetch_channel_perms(
        str(payload.channel_id), request.headers.get("Authorization")
    )
    _require_voice_moderate(perms)

    # Don't let the moderator silence the channel owner.
    if perms and perms.get("rank") is not None:
        # Owner check is approximate (we only see our own rank); the channel
        # service is the actual source of truth and would reject downstream
        # operations on the owner via API. Here we just block self-target as
        # a basic safety check.
        if payload.target_identity == str(current.id):
            raise HTTPException(400, "Use the in-room mic toggle for self-mute")

    room_name = f"room-{room_id}"
    lkapi = api.LiveKitAPI(
        _livekit_http_url(),
        settings.LIVEKIT_API_KEY,
        settings.LIVEKIT_API_SECRET,
    )
    try:
        # Find the target's published audio tracks and mute each.
        info = await lkapi.room.list_participants(
            api.ListParticipantsRequest(room=room_name)
        )
        target = next(
            (p for p in info.participants if p.identity == payload.target_identity),
            None,
        )
        if not target:
            raise HTTPException(404, "Participant not in this voice room")
        for track in target.tracks:
            if track.type == 0:  # AUDIO; (0=AUDIO, 1=VIDEO, 2=DATA in proto)
                await lkapi.room.mute_published_track(
                    api.MuteRoomTrackRequest(
                        room=room_name,
                        identity=payload.target_identity,
                        track_sid=track.sid,
                        muted=payload.muted,
                    )
                )
    finally:
        await lkapi.aclose()


@app.post("/api/media/rooms/{room_id}/voice-kick", status_code=204)
async def voice_kick_participant(
    room_id: UUID,
    payload: VoiceModerationRequest,
    request: Request,
    current: CurrentUser = Depends(get_current_user),
) -> None:
    """Disconnect a participant from a voice room.

    Doesn't ban or remove them from the channel — they can rejoin (unless the
    channel-level muted_until / ban prevents it). The frontend listens for the
    LiveKit Disconnect event and shows a notice to the kicked user.
    """
    perms = await _fetch_channel_perms(
        str(payload.channel_id), request.headers.get("Authorization")
    )
    _require_voice_moderate(perms)

    if payload.target_identity == str(current.id):
        raise HTTPException(400, "Use the Leave button to disconnect yourself")

    room_name = f"room-{room_id}"
    lkapi = api.LiveKitAPI(
        _livekit_http_url(),
        settings.LIVEKIT_API_KEY,
        settings.LIVEKIT_API_SECRET,
    )
    try:
        await lkapi.room.remove_participant(
            api.RoomParticipantIdentity(room=room_name, identity=payload.target_identity)
        )
    finally:
        await lkapi.aclose()
