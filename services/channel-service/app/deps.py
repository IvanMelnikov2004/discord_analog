from dataclasses import dataclass
from datetime import datetime, timezone
import json
from uuid import UUID

from fastapi import Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db import get_db, redis_pub
from app.models import Channel, ChannelMember, MemberRole, Role
from shared.deps import CurrentUser, make_current_user_dependency
from shared.permissions import OWNER_RANK, Permission, has_permission

_s = get_settings()
get_current_user = make_current_user_dependency(_s.JWT_SECRET_KEY, _s.JWT_ALGORITHM)


async def publish_user_event(user_id: UUID, event_type: str, data: dict) -> None:
    """Fan out an event to a single user's WebSocket channel.

    Gateway subscribes clients to "user:<uuid>" on connect, so any event we
    publish here is delivered live. Failures are logged but don't crash the
    request — moderation actions must succeed even if Redis hiccups.
    """
    try:
        await redis_pub.publish(
            f"user:{user_id}",
            json.dumps({"type": event_type, "data": data}, default=str),
        )
    except Exception:
        # Best-effort: never block a moderation action on a pub/sub error.
        pass


async def is_member_currently_muted(
    db: AsyncSession, member: ChannelMember
) -> bool:
    """Return True if the member is muted right now.

    A timed mute is considered expired once `muted_until` is in the past — in
    that case we clear the flag and persist it so the user is auto-unmuted.
    """
    if not member.muted:
        return False
    if member.muted_until is None:
        return True  # permanent
    # Normalize naive datetimes (e.g. SQLite test backend) to UTC.
    until = member.muted_until
    if until.tzinfo is None:
        until = until.replace(tzinfo=timezone.utc)
    if until <= datetime.now(timezone.utc):
        member.muted = False
        member.muted_until = None
        await db.commit()
        return False
    return True


@dataclass
class MemberContext:
    """Everything we need to authorize an action in a channel."""
    member: ChannelMember
    permissions: int          # OR of all role bitmasks
    rank: int                 # highest role position; OWNER_RANK if owner
    is_owner: bool


async def get_member_context(
    db: AsyncSession, channel_id: UUID, user_id: UUID
) -> MemberContext:
    """Resolve a user's membership, effective permissions, and hierarchy rank."""
    member_result = await db.execute(
        select(ChannelMember).where(
            (ChannelMember.channel_id == channel_id) & (ChannelMember.user_id == user_id)
        )
    )
    member = member_result.scalar_one_or_none()
    if member is None:
        raise HTTPException(403, "Not a member of this channel")

    # Is this user the channel owner?
    channel_result = await db.execute(select(Channel).where(Channel.id == channel_id))
    channel = channel_result.scalar_one_or_none()
    is_owner = bool(channel and channel.owner_id == user_id)

    role_result = await db.execute(
        select(Role)
        .join(MemberRole, MemberRole.role_id == Role.id)
        .where(MemberRole.member_id == member.id)
    )
    roles = role_result.scalars().all()

    perms = 0
    highest_position = 0
    for r in roles:
        perms |= r.permissions
        if r.position > highest_position:
            highest_position = r.position

    # Owner always has full permissions and the top rank, regardless of roles.
    if is_owner:
        perms |= int(Permission.ADMINISTRATOR)
        rank = OWNER_RANK
    else:
        rank = highest_position

    return MemberContext(member=member, permissions=perms, rank=rank, is_owner=is_owner)


# Backwards-compatible helper used by some routes/tests.
async def get_member_permissions(
    db: AsyncSession, channel_id: UUID, user_id: UUID
) -> tuple[ChannelMember, int]:
    ctx = await get_member_context(db, channel_id, user_id)
    return ctx.member, ctx.permissions


def require_permission(perm: Permission):
    """Dependency factory: ensure caller has `perm` in given channel.

    Returns the full MemberContext so downstream handlers can also do
    hierarchy checks (rank/owner) without re-querying.
    """

    async def checker(
        channel_id: UUID,
        current: CurrentUser = Depends(get_current_user),
        db: AsyncSession = Depends(get_db),
    ) -> MemberContext:
        ctx = await get_member_context(db, channel_id, current.id)
        if not has_permission(ctx.permissions, perm):
            raise HTTPException(403, _PERMISSION_DENIED_RU.get(
                perm.name, f"Недостаточно прав: {perm.name}"
            ))
        return ctx

    return checker


# Human-readable Russian messages for permission denials. The dict key is the
# Permission enum's `.name`; if missing, we fall back to a generic message.
_PERMISSION_DENIED_RU: dict[str, str] = {
    "VIEW_CHANNEL":        "У вас нет доступа к этому каналу",
    "SEND_MESSAGES":       "У вас нет прав писать в этом канале",
    "MANAGE_MESSAGES":     "У вас нет прав удалять чужие сообщения",
    "KICK_MEMBERS":        "У вас нет прав исключать участников",
    "BAN_MEMBERS":         "У вас нет прав банить участников",
    "MUTE_MEMBERS":        "У вас нет прав мьютить участников",
    "MANAGE_ROLES":        "У вас нет прав управлять ролями",
    "MANAGE_CHANNELS":     "У вас нет прав управлять каналом",
    "CREATE_INVITE":       "У вас нет прав создавать приглашения",
    "CONNECT_VOICE":       "У вас нет прав заходить в голосовые комнаты",
    "SPEAK_VOICE":         "У вас нет прав говорить в голосовых комнатах",
    "VOICE_MODERATE":      "У вас нет прав модерировать голос",
}


async def get_target_rank(
    db: AsyncSession, channel_id: UUID, target_member: ChannelMember
) -> tuple[int, bool]:
    """Compute a target member's rank and owner flag (for hierarchy checks)."""
    channel_result = await db.execute(select(Channel).where(Channel.id == channel_id))
    channel = channel_result.scalar_one_or_none()
    target_is_owner = bool(channel and channel.owner_id == target_member.user_id)
    if target_is_owner:
        return OWNER_RANK, True

    role_result = await db.execute(
        select(Role)
        .join(MemberRole, MemberRole.role_id == Role.id)
        .where(MemberRole.member_id == target_member.id)
    )
    highest = 0
    for r in role_result.scalars().all():
        if r.position > highest:
            highest = r.position
    return highest, False
