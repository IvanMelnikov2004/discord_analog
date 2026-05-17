from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class ProfileCreate(BaseModel):
    user_id: UUID
    username: str = Field(min_length=3, max_length=50)


class ProfileUpdate(BaseModel):
    display_name: str | None = Field(default=None, max_length=100)
    bio: str | None = Field(default=None, max_length=500)
    status: str | None = Field(default=None, pattern=r"^(online|idle|dnd|offline)$")


class ProfileResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    user_id: UUID
    username: str
    display_name: str | None
    status: str
    bio: str | None
    created_at: datetime


class FriendRequest(BaseModel):
    target_user_id: UUID


class FriendshipResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    requester_id: UUID
    addressee_id: UUID
    status: str
    created_at: datetime
