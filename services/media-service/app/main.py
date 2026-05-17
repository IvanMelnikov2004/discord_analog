from contextlib import asynccontextmanager
from uuid import UUID

from fastapi import Depends, FastAPI, HTTPException
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


class TokenResponse(BaseModel):
    token: str
    url: str
    room: str
    identity: str


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/media/token", response_model=TokenResponse)
async def issue_token(
    payload: TokenRequest, current: CurrentUser = Depends(get_current_user)
) -> TokenResponse:
    """Issue a short-lived LiveKit access token.

    NOTE: For production, verify that `current.id` is allowed in the given room
    (call channel-service first). Skipped for MVP.
    """
    identity = payload.identity or str(current.id)
    room_name = f"room-{payload.room_id}"

    try:
        token = (
            api.AccessToken(settings.LIVEKIT_API_KEY, settings.LIVEKIT_API_SECRET)
            .with_identity(identity)
            .with_name(identity)
            .with_grants(
                api.VideoGrants(
                    room_join=True,
                    room=room_name,
                    can_publish=True,
                    can_subscribe=True,
                )
            )
            .to_jwt()
        )
    except Exception as e:
        raise HTTPException(500, f"Failed to mint token: {e}") from e

    return TokenResponse(token=token, url=settings.LIVEKIT_URL, room=room_name, identity=identity)
