import json
from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query

from app.db import messages_collection, redis_pub
from app.deps import get_current_user
from app.schemas import MessageCreate, MessageResponse, make_dm_pair, new_message_id
from shared.deps import CurrentUser

router = APIRouter(prefix="/api/messages", tags=["messages"])


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
    current: CurrentUser = Depends(get_current_user),
) -> MessageResponse:
    if (payload.room_id is None) == (payload.recipient_id is None):
        raise HTTPException(400, "Provide exactly one of room_id or recipient_id")

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

    # Publish to Redis for gateway-service to deliver
    channel = (
        f"room:{payload.room_id}" if payload.room_id else f"dm:{make_dm_pair(current.id, payload.recipient_id)}"
    )
    await redis_pub.publish(
        channel,
        json.dumps(
            {
                "type": "message.new",
                "data": response.model_dump(mode="json"),
            }
        ),
    )
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


@router.delete("/{message_id}", status_code=204)
async def delete_message(
    message_id: UUID,
    current: CurrentUser = Depends(get_current_user),
) -> None:
    doc = await messages_collection.find_one({"id": str(message_id)})
    if not doc:
        raise HTTPException(404, "Not found")
    if doc["sender_id"] != str(current.id):
        raise HTTPException(403, "You can only delete your own messages")
    await messages_collection.delete_one({"id": str(message_id)})

    channel = (
        f"room:{doc['room_id']}" if doc.get("room_id") else f"dm:{doc['dm_pair']}"
    )
    await redis_pub.publish(
        channel,
        json.dumps({"type": "message.deleted", "data": {"id": str(message_id)}}),
    )
