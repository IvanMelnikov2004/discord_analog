from datetime import datetime
from typing import Literal
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field


class MessageCreate(BaseModel):
    """Message body, with E2EE payload.

    Either room_id (group) or recipient_id (DM) must be provided.
    The encrypted blob is opaque to the server.
    """
    room_id: UUID | None = None
    recipient_id: UUID | None = None
    # Base64 ciphertext (AES-GCM output: nonce + ciphertext + tag)
    ciphertext: str = Field(min_length=1, max_length=65536)
    # Key id of the sender key used (Sender Keys scheme)
    sender_key_id: str | None = None
    msg_type: Literal["text", "system"] = "text"


class MessageResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: UUID
    sender_id: UUID
    room_id: UUID | None = None
    recipient_id: UUID | None = None
    ciphertext: str
    sender_key_id: str | None = None
    msg_type: str
    created_at: datetime
    edited_at: datetime | None = None


def make_dm_pair(a: UUID, b: UUID) -> str:
    """Canonical pair key for DM, regardless of order."""
    pair = sorted([str(a), str(b)])
    return f"{pair[0]}:{pair[1]}"


def new_message_id() -> UUID:
    return uuid4()
