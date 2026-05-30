from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


# ---------- Channels ----------

class ChannelCreate(BaseModel):
    name: str = Field(min_length=2, max_length=100)
    description: str | None = Field(default=None, max_length=2000)


class ChannelResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    name: str
    owner_id: UUID
    description: str | None
    created_at: datetime


# ---------- Rooms ----------

class RoomCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    room_type: str = Field(pattern=r"^(text|voice)$")


class RoomResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    channel_id: UUID
    name: str
    room_type: str
    position: int


# ---------- Roles ----------

class RoleCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    permissions: int = 0
    color: str | None = Field(default=None, pattern=r"^#[0-9A-Fa-f]{6}$")


class RoleUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    permissions: int | None = None
    color: str | None = Field(default=None, pattern=r"^#[0-9A-Fa-f]{6}$")


class RoleResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    channel_id: UUID
    name: str
    permissions: int
    color: str | None
    position: int
    is_default: bool


# ---------- Members ----------

class MemberResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    channel_id: UUID
    user_id: UUID
    nickname: str | None
    muted: bool
    joined_at: datetime


class MemberRoleAssign(BaseModel):
    role_id: UUID


class MyPermissionsResponse(BaseModel):
    """Effective permissions of the current user in a channel.

    `permissions` is the raw bitmask; `is_owner`/`is_admin` are convenience
    flags; `names` lists the granted permission names so the frontend can
    decide which controls to show without re-deriving the bitmask.
    """
    channel_id: UUID
    permissions: int
    rank: int
    is_owner: bool
    is_admin: bool
    names: list[str]
    # Mute status of the calling user in this channel — used by message-service
    # to deny chat messages and by the frontend to disable input/voice publish.
    muted: bool = False
    muted_until: datetime | None = None


# ---------- Invites ----------

class InviteCreate(BaseModel):
    ttl_seconds: int = Field(default=86400, ge=60, le=604800)  # 1 min .. 7 days
    max_uses: int | None = Field(default=None, ge=1, le=100)


class InviteResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    code: str
    channel_id: UUID
    expires_at: datetime
    max_uses: int | None
    uses: int


class InviteAcceptResponse(BaseModel):
    channel_id: UUID
    member_id: UUID


# ---------- Bans ----------

class BanCreate(BaseModel):
    user_id: UUID
    reason: str | None = Field(default=None, max_length=1000)


class BanResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    channel_id: UUID
    user_id: UUID
    reason: str | None
    banned_by: UUID
    created_at: datetime
