import json
from datetime import datetime, timezone
from uuid import UUID

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request

from app.config import get_settings
from app.db import messages_collection, redis_pub, sender_keys_collection
from app.deps import get_current_user
from app.ratelimit import enforce_message_limit
from app.schemas import (
    MessageCreate,
    MessageResponse,
    SenderKeyEnvelopeBatch,
    SenderKeyEnvelopeResponse,
    make_dm_pair,
    new_message_id,
)
from shared.deps import CurrentUser

router = APIRouter(prefix="/api/messages", tags=["messages"])
settings = get_settings()


async def _fetch_channel_status(
    channel_id: str, auth_header: str | None
) -> dict | None:
    """Fetch the caller's status in a channel from channel-service.

    Returns the full /me/permissions response (dict with is_admin, is_owner,
    names, muted, ...) or None if anything fails. Fail-closed.
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


async def _can_manage_messages(channel_id: str, auth_header: str | None) -> bool:
    """Whether the caller has MANAGE_MESSAGES in the channel. Fail-closed."""
    data = await _fetch_channel_status(channel_id, auth_header)
    if data is None:
        return False
    return bool(data.get("is_admin") or data.get("is_owner")) or (
        "MANAGE_MESSAGES" in data.get("names", [])
    )



def _to_response(doc: dict) -> MessageResponse:
    return MessageResponse(
        id=UUID(doc["id"]),
        sender_id=UUID(doc["sender_id"]),
        room_id=UUID(doc["room_id"]) if doc.get("room_id") else None,
        recipient_id=UUID(doc["recipient_id"]) if doc.get("recipient_id") else None,
        ciphertext=doc["ciphertext"],
        sender_key_id=doc.get("sender_key_id"),
        msg_type=doc.get("msg_type", "text"),
        created_at=doc["created_at"],
        edited_at=doc.get("edited_at"),
    )


@router.post("", response_model=MessageResponse, status_code=201)
async def send_message(
    payload: MessageCreate,
    request: Request,
    current: CurrentUser = Depends(get_current_user),
) -> MessageResponse:
    if (payload.room_id is None) == (payload.recipient_id is None):
        raise HTTPException(400, "Provide exactly one of room_id or recipient_id")

    # For room messages, verify the sender is not muted in the channel.
    # SEND_MESSAGES permission is also checked (so revoking that role-flag
    # silences a user too). DMs have no channel context.
    if payload.room_id is not None:
        status = await _fetch_channel_status(
            str(payload.channel_id) if payload.channel_id else "",
            request.headers.get("Authorization"),
        )
        if status is None:
            # No channel context => can't verify status — reject (fail-closed).
            raise HTTPException(403, "Cannot verify channel membership")
        if status.get("muted"):
            raise HTTPException(403, "Вы замьючены в этом канале")
        # Admin/owner bypass the SEND_MESSAGES bitmask.
        if not (
            status.get("is_admin")
            or status.get("is_owner")
            or "SEND_MESSAGES" in status.get("names", [])
        ):
            raise HTTPException(403, "Missing permission: SEND_MESSAGES")

    # Rate-limit per (user, conversation). Scope distinguishes rooms from DMs
    # so a chatty channel doesn't eat into your DM budget and vice versa.
    scope = (
        f"room:{payload.room_id}"
        if payload.room_id is not None
        else f"dm:{make_dm_pair(current.id, payload.recipient_id)}"
    )
    retry_after = await enforce_message_limit(str(current.id), scope)
    if retry_after is not None:
        seconds = max(1, int(retry_after + 0.5))
        raise HTTPException(
            status_code=429,
            detail=f"Слишком много сообщений. Попробуйте через {seconds} с.",
            headers={"Retry-After": str(seconds)},
        )

    msg_id = new_message_id()
    doc = {
        "id": str(msg_id),
        "sender_id": str(current.id),
        "room_id": str(payload.room_id) if payload.room_id else None,
        "recipient_id": str(payload.recipient_id) if payload.recipient_id else None,
        "dm_pair": make_dm_pair(current.id, payload.recipient_id) if payload.recipient_id else None,
        "ciphertext": payload.ciphertext,
        "sender_key_id": payload.sender_key_id,
        "msg_type": payload.msg_type,
        "created_at": datetime.now(timezone.utc),
        "edited_at": None,
    }
    await messages_collection.insert_one(doc)
    response = _to_response(doc)

    # Publish to Redis for gateway-service to deliver. For DMs we also enrich
    # the event with dm_pair (front-end uses it to match the open conversation)
    # and additionally push to the recipient's personal channel so their UI
    # learns about a new DM even if they haven't opened that conversation yet.
    event_data = response.model_dump(mode="json")
    if payload.recipient_id is not None:
        event_data["dm_pair"] = make_dm_pair(current.id, payload.recipient_id)

    if payload.room_id is not None:
        channel = f"room:{payload.room_id}"
        await redis_pub.publish(
            channel,
            json.dumps({"type": "message.new", "data": event_data}),
        )
    else:
        pair_channel = f"dm:{make_dm_pair(current.id, payload.recipient_id)}"
        event_json = json.dumps({"type": "message.new", "data": event_data})
        # Broadcast on the dm:<pair> topic for clients with that chat open
        await redis_pub.publish(pair_channel, event_json)
        # Also poke the recipient's personal channel (auto-subscribed at WS
        # connect) so their sidebar / unread state updates immediately, even
        # when they don't have the DM page open. Sender skipped — they
        # already got the message back from the POST response.
        await redis_pub.publish(f"user:{payload.recipient_id}", event_json)

    return response


@router.get("/room/{room_id}", response_model=list[MessageResponse])
async def list_room_messages(
    room_id: UUID,
    limit: int = Query(50, ge=1, le=200),
    before: datetime | None = Query(None),
    _: CurrentUser = Depends(get_current_user),
) -> list[MessageResponse]:
    """NOTE: membership/permission check should be added via call to channel-service.
    For MVP simplicity we trust JWT here.
    """
    query: dict = {"room_id": str(room_id)}
    if before:
        query["created_at"] = {"$lt": before}

    cursor = messages_collection.find(query).sort("created_at", -1).limit(limit)
    docs = await cursor.to_list(length=limit)
    return [_to_response(d) for d in reversed(docs)]


@router.get("/dm/{other_user_id}", response_model=list[MessageResponse])
async def list_dm_messages(
    other_user_id: UUID,
    limit: int = Query(50, ge=1, le=200),
    before: datetime | None = Query(None),
    current: CurrentUser = Depends(get_current_user),
) -> list[MessageResponse]:
    pair = make_dm_pair(current.id, other_user_id)
    query: dict = {"dm_pair": pair}
    if before:
        query["created_at"] = {"$lt": before}

    cursor = messages_collection.find(query).sort("created_at", -1).limit(limit)
    docs = await cursor.to_list(length=limit)
    return [_to_response(d) for d in reversed(docs)]


@router.get("/dm-conversations")
async def list_dm_conversations(
    current: CurrentUser = Depends(get_current_user),
) -> list[dict]:
    """Return distinct DM partners with the timestamp of the last message.

    Used by the frontend to render the "Direct Messages" sidebar list.
    """
    my_id = str(current.id)
    pipeline = [
        # Only DMs that I'm part of
        {"$match": {"dm_pair": {"$regex": my_id}}},
        # For each conversation keep the most recent message
        {"$sort": {"created_at": -1}},
        {
            "$group": {
                "_id": "$dm_pair",
                "last_at": {"$first": "$created_at"},
                "last_sender": {"$first": "$sender_id"},
                "last_recipient": {"$first": "$recipient_id"},
            }
        },
        {"$sort": {"last_at": -1}},
        {"$limit": 50},
    ]
    docs = await messages_collection.aggregate(pipeline).to_list(length=50)
    out = []
    for d in docs:
        # dm_pair = "<uuidA>:<uuidB>" sorted; the partner is the one that's not me.
        a, b = d["_id"].split(":")
        partner = b if a == my_id else a
        out.append({"partner_id": partner, "last_at": d["last_at"]})
    return out


@router.delete("/{message_id}", status_code=204)
async def delete_message(
    message_id: UUID,
    request: Request,
    channel_id: str | None = Query(None),
    current: CurrentUser = Depends(get_current_user),
) -> None:
    doc = await messages_collection.find_one({"id": str(message_id)})
    if not doc:
        raise HTTPException(404, "Not found")

    is_own = doc["sender_id"] == str(current.id)
    if not is_own:
        # Deleting someone else's message requires MANAGE_MESSAGES in the
        # channel. We ask channel-service (the source of truth for roles).
        # Only meaningful for room messages; DMs have no moderators.
        if not doc.get("room_id"):
            raise HTTPException(403, "You can only delete your own messages")
        allowed = await _can_manage_messages(
            channel_id or "", request.headers.get("Authorization")
        )
        if not allowed:
            raise HTTPException(403, "Missing permission: MANAGE_MESSAGES")

    await messages_collection.delete_one({"id": str(message_id)})

    channel = (
        f"room:{doc['room_id']}" if doc.get("room_id") else f"dm:{doc['dm_pair']}"
    )
    await redis_pub.publish(
        channel,
        json.dumps({"type": "message.deleted", "data": {"id": str(message_id)}}),
    )


# ---------- Sender key distribution (E2EE) ----------

@router.post("/sender-keys", status_code=201)
async def distribute_sender_keys(
    batch: SenderKeyEnvelopeBatch,
    current: CurrentUser = Depends(get_current_user),
) -> dict:
    """Upload encrypted sender-key envelopes for other room members.

    The caller has just generated (or rotated) their AES sender key for a
    room and wraps it for each recipient via pairwise ECDH on the client.
    The server stores the resulting ciphertext only — it cannot read it.
    """
    now = datetime.now(timezone.utc)
    for env in batch.envelopes:
        doc = {
            "room_id": str(env.room_id),
            "sender_id": str(current.id),
            "recipient_id": str(env.recipient_id),
            "key_id": env.key_id,
            "encrypted_key": env.encrypted_key,
            "sender_pub": env.sender_pub,
            "created_at": now,
        }
        # Upsert so re-distribution (same sender→recipient pair) overwrites.
        await sender_keys_collection.update_one(
            {
                "room_id": str(env.room_id),
                "sender_id": str(current.id),
                "recipient_id": str(env.recipient_id),
            },
            {"$set": doc},
            upsert=True,
        )

        # Notify the recipient over their personal user channel so any open
        # client can fetch and unwrap the new key without polling.
        await redis_pub.publish(
            f"user:{env.recipient_id}",
            json.dumps(
                {
                    "type": "senderkey.new",
                    "data": {
                        "room_id": str(env.room_id),
                        "sender_id": str(current.id),
                        "key_id": env.key_id,
                    },
                }
            ),
        )

    return {"distributed": len(batch.envelopes)}


@router.get("/sender-keys/{room_id}", response_model=list[SenderKeyEnvelopeResponse])
async def get_my_sender_keys(
    room_id: UUID,
    current: CurrentUser = Depends(get_current_user),
) -> list[SenderKeyEnvelopeResponse]:
    """Fetch all sender-key envelopes addressed to me in this room."""
    cursor = sender_keys_collection.find(
        {"room_id": str(room_id), "recipient_id": str(current.id)}
    )
    docs = await cursor.to_list(length=500)
    return [
        SenderKeyEnvelopeResponse(
            room_id=UUID(d["room_id"]),
            sender_id=UUID(d["sender_id"]),
            key_id=d["key_id"],
            encrypted_key=d["encrypted_key"],
            sender_pub=d["sender_pub"],
            created_at=d["created_at"],
        )
        for d in docs
    ]
