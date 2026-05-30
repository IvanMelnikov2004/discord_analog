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
    # Channel that owns the room (required when room_id is set, so the server
    # can verify mute status / permissions in channel-service). Ignored for DM.
    channel_id: UUID | None = None
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


# ---------- Sender key envelopes (E2EE key distribution) ----------

class SenderKeyEnvelope(BaseModel):
    """One sender's AES key, encrypted for one recipient via pairwise ECDH.

    The server never sees the plaintext sender key — only this ciphertext.
    `sender_pub` is the sender's ECDH public key (SPKI base64) so the
    recipient can derive the same shared secret on their side. `key_id`
    identifies which version of the sender key this is (lets clients detect
    rotation, though MVP doesn't rotate).
    """
    room_id: UUID
    recipient_id: UUID
    key_id: str = Field(min_length=1, max_length=128)
    # base64(AES-GCM(ECDH_shared_secret, sender_key)) — nonce + ct + tag
    encrypted_key: str = Field(min_length=1, max_length=8192)
    # Sender's ECDH public key as base64 SPKI
    sender_pub: str = Field(min_length=1, max_length=2048)


class SenderKeyEnvelopeBatch(BaseModel):
    """Distribute one sender key to several recipients in a single call."""
    envelopes: list[SenderKeyEnvelope] = Field(min_length=1, max_length=200)


class SenderKeyEnvelopeResponse(BaseModel):
    """An envelope addressed to the current user, ready to unwrap."""
    room_id: UUID
    sender_id: UUID
    key_id: str
    encrypted_key: str
    sender_pub: str
    created_at: datetime
