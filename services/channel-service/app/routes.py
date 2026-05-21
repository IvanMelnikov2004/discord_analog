import secrets
import string
from datetime import datetime, timedelta, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.deps import get_current_user, get_member_permissions, require_permission
from app.models import (
    Ban,
    Channel,
    ChannelMember,
    Invite,
    MemberRole,
    Role,
    Room,
)
from app.schemas import (
    BanCreate,
    BanResponse,
    ChannelCreate,
    ChannelResponse,
    InviteAcceptResponse,
    InviteCreate,
    InviteResponse,
    MemberResponse,
    MemberRoleAssign,
    RoleCreate,
    RoleResponse,
    RoleUpdate,
    RoomCreate,
    RoomResponse,
)
from shared.deps import CurrentUser
from shared.permissions import Permission, has_permission

router = APIRouter(prefix="/api/channels", tags=["channels"])
invites_router = APIRouter(prefix="/api/invites", tags=["invites"])


def _gen_invite_code(n: int = 8) -> str:
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(n))


def _is_expired(expires_at: datetime) -> bool:
    """Compare timezone-aware "now" with a possibly-naive DB datetime.

    SQLite via aiosqlite drops tzinfo; Postgres preserves it. Normalize.
    """
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    return expires_at < datetime.now(timezone.utc)


# ---------- Channels ----------

@router.post("", response_model=ChannelResponse, status_code=201)
async def create_channel(
    payload: ChannelCreate,
    current: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ChannelResponse:
    channel = Channel(name=payload.name, description=payload.description, owner_id=current.id)
    db.add(channel)
    await db.flush()

    # Default @everyone role + admin role
    default_role = Role(
        channel_id=channel.id,
        name="@everyone",
        permissions=Permission.default_member(),
        is_default=True,
        position=0,
    )
    admin_role = Role(
        channel_id=channel.id,
        name="Admin",
        permissions=Permission.admin(),
        is_default=False,
        position=1,
    )
    db.add_all([default_role, admin_role])
    await db.flush()

    # Default text room
    general = Room(channel_id=channel.id, name="general", room_type="text", position=0)
    voice = Room(channel_id=channel.id, name="General Voice", room_type="voice", position=1)
    db.add_all([general, voice])

    # Owner joins as member with admin role
    member = ChannelMember(channel_id=channel.id, user_id=current.id)
    db.add(member)
    await db.flush()
    db.add(MemberRole(member_id=member.id, role_id=admin_role.id))
    db.add(MemberRole(member_id=member.id, role_id=default_role.id))

    await db.commit()
    await db.refresh(channel)
    return ChannelResponse.model_validate(channel)


@router.get("", response_model=list[ChannelResponse])
async def list_my_channels(
    current: CurrentUser = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> list[ChannelResponse]:
    result = await db.execute(
        select(Channel)
        .join(ChannelMember, ChannelMember.channel_id == Channel.id)
        .where(ChannelMember.user_id == current.id)
    )
    return [ChannelResponse.model_validate(c) for c in result.scalars().all()]


@router.get("/{channel_id}", response_model=ChannelResponse)
async def get_channel(
    channel_id: UUID,
    current: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ChannelResponse:
    await get_member_permissions(db, channel_id, current.id)
    result = await db.execute(select(Channel).where(Channel.id == channel_id))
    ch = result.scalar_one_or_none()
    if not ch:
        raise HTTPException(404, "Not found")
    return ChannelResponse.model_validate(ch)


@router.delete("/{channel_id}", status_code=204)
async def delete_channel(
    channel_id: UUID,
    current: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    result = await db.execute(select(Channel).where(Channel.id == channel_id))
    ch = result.scalar_one_or_none()
    if not ch:
        raise HTTPException(404, "Not found")
    if ch.owner_id != current.id:
        raise HTTPException(403, "Only owner can delete the channel")
    await db.delete(ch)
    await db.commit()


# ---------- Rooms ----------

@router.post("/{channel_id}/rooms", response_model=RoomResponse, status_code=201)
async def create_room(
    channel_id: UUID,
    payload: RoomCreate,
    ctx=Depends(require_permission(Permission.MANAGE_CHANNELS)),
    db: AsyncSession = Depends(get_db),
) -> RoomResponse:
    room = Room(channel_id=channel_id, name=payload.name, room_type=payload.room_type)
    db.add(room)
    await db.commit()
    await db.refresh(room)
    return RoomResponse.model_validate(room)


@router.get("/{channel_id}/rooms", response_model=list[RoomResponse])
async def list_rooms(
    channel_id: UUID,
    current: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[RoomResponse]:
    await get_member_permissions(db, channel_id, current.id)
    result = await db.execute(
        select(Room).where(Room.channel_id == channel_id).order_by(Room.position)
    )
    return [RoomResponse.model_validate(r) for r in result.scalars().all()]


@router.delete("/{channel_id}/rooms/{room_id}", status_code=204)
async def delete_room(
    channel_id: UUID,
    room_id: UUID,
    ctx=Depends(require_permission(Permission.MANAGE_CHANNELS)),
    db: AsyncSession = Depends(get_db),
) -> None:
    result = await db.execute(
        select(Room).where((Room.id == room_id) & (Room.channel_id == channel_id))
    )
    room = result.scalar_one_or_none()
    if not room:
        raise HTTPException(404, "Not found")
    await db.delete(room)
    await db.commit()


# ---------- Roles ----------

@router.post("/{channel_id}/roles", response_model=RoleResponse, status_code=201)
async def create_role(
    channel_id: UUID,
    payload: RoleCreate,
    ctx=Depends(require_permission(Permission.MANAGE_ROLES)),
    db: AsyncSession = Depends(get_db),
) -> RoleResponse:
    role = Role(
        channel_id=channel_id,
        name=payload.name,
        permissions=payload.permissions,
        color=payload.color,
    )
    db.add(role)
    await db.commit()
    await db.refresh(role)
    return RoleResponse.model_validate(role)


@router.get("/{channel_id}/roles", response_model=list[RoleResponse])
async def list_roles(
    channel_id: UUID,
    current: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[RoleResponse]:
    await get_member_permissions(db, channel_id, current.id)
    result = await db.execute(
        select(Role).where(Role.channel_id == channel_id).order_by(Role.position)
    )
    return [RoleResponse.model_validate(r) for r in result.scalars().all()]


@router.patch("/{channel_id}/roles/{role_id}", response_model=RoleResponse)
async def update_role(
    channel_id: UUID,
    role_id: UUID,
    payload: RoleUpdate,
    ctx=Depends(require_permission(Permission.MANAGE_ROLES)),
    db: AsyncSession = Depends(get_db),
) -> RoleResponse:
    result = await db.execute(
        select(Role).where((Role.id == role_id) & (Role.channel_id == channel_id))
    )
    role = result.scalar_one_or_none()
    if not role:
        raise HTTPException(404, "Not found")
    if role.is_default and payload.name is not None:
        raise HTTPException(400, "Cannot rename @everyone")
    for k, v in payload.model_dump(exclude_unset=True).items():
        setattr(role, k, v)
    await db.commit()
    await db.refresh(role)
    return RoleResponse.model_validate(role)


@router.delete("/{channel_id}/roles/{role_id}", status_code=204)
async def delete_role(
    channel_id: UUID,
    role_id: UUID,
    ctx=Depends(require_permission(Permission.MANAGE_ROLES)),
    db: AsyncSession = Depends(get_db),
) -> None:
    result = await db.execute(
        select(Role).where((Role.id == role_id) & (Role.channel_id == channel_id))
    )
    role = result.scalar_one_or_none()
    if not role:
        raise HTTPException(404, "Not found")
    if role.is_default:
        raise HTTPException(400, "Cannot delete @everyone")
    await db.delete(role)
    await db.commit()


# ---------- Members ----------

@router.get("/{channel_id}/members", response_model=list[MemberResponse])
async def list_members(
    channel_id: UUID,
    current: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[MemberResponse]:
    await get_member_permissions(db, channel_id, current.id)
    result = await db.execute(select(ChannelMember).where(ChannelMember.channel_id == channel_id))
    return [MemberResponse.model_validate(m) for m in result.scalars().all()]


@router.post("/{channel_id}/members/{member_id}/roles", status_code=204)
async def assign_role(
    channel_id: UUID,
    member_id: UUID,
    payload: MemberRoleAssign,
    ctx=Depends(require_permission(Permission.MANAGE_ROLES)),
    db: AsyncSession = Depends(get_db),
) -> None:
    member_result = await db.execute(
        select(ChannelMember).where(
            (ChannelMember.id == member_id) & (ChannelMember.channel_id == channel_id)
        )
    )
    if not member_result.scalar_one_or_none():
        raise HTTPException(404, "Member not found")

    role_result = await db.execute(
        select(Role).where((Role.id == payload.role_id) & (Role.channel_id == channel_id))
    )
    if not role_result.scalar_one_or_none():
        raise HTTPException(404, "Role not found")

    # ignore duplicate
    existing = await db.execute(
        select(MemberRole).where(
            (MemberRole.member_id == member_id) & (MemberRole.role_id == payload.role_id)
        )
    )
    if existing.scalar_one_or_none():
        return

    db.add(MemberRole(member_id=member_id, role_id=payload.role_id))
    await db.commit()


@router.delete("/{channel_id}/members/{member_id}/roles/{role_id}", status_code=204)
async def revoke_role(
    channel_id: UUID,
    member_id: UUID,
    role_id: UUID,
    ctx=Depends(require_permission(Permission.MANAGE_ROLES)),
    db: AsyncSession = Depends(get_db),
) -> None:
    result = await db.execute(
        select(MemberRole).where(
            (MemberRole.member_id == member_id) & (MemberRole.role_id == role_id)
        )
    )
    mr = result.scalar_one_or_none()
    if mr:
        await db.delete(mr)
        await db.commit()


@router.delete("/{channel_id}/members/{member_id}", status_code=204)
async def kick_member(
    channel_id: UUID,
    member_id: UUID,
    ctx=Depends(require_permission(Permission.KICK_MEMBERS)),
    db: AsyncSession = Depends(get_db),
) -> None:
    result = await db.execute(
        select(ChannelMember).where(
            (ChannelMember.id == member_id) & (ChannelMember.channel_id == channel_id)
        )
    )
    member = result.scalar_one_or_none()
    if not member:
        raise HTTPException(404, "Not found")
    await db.delete(member)
    await db.commit()


@router.patch("/{channel_id}/members/{member_id}/mute", status_code=204)
async def mute_member(
    channel_id: UUID,
    member_id: UUID,
    muted: bool = True,
    ctx=Depends(require_permission(Permission.MUTE_MEMBERS)),
    db: AsyncSession = Depends(get_db),
) -> None:
    result = await db.execute(
        select(ChannelMember).where(
            (ChannelMember.id == member_id) & (ChannelMember.channel_id == channel_id)
        )
    )
    member = result.scalar_one_or_none()
    if not member:
        raise HTTPException(404, "Not found")
    member.muted = muted
    await db.commit()


# ---------- Bans ----------

@router.post("/{channel_id}/bans", response_model=BanResponse, status_code=201)
async def ban_user(
    channel_id: UUID,
    payload: BanCreate,
    current: CurrentUser = Depends(get_current_user),
    ctx=Depends(require_permission(Permission.BAN_MEMBERS)),
    db: AsyncSession = Depends(get_db),
) -> BanResponse:
    # Remove from members if present
    result = await db.execute(
        select(ChannelMember).where(
            (ChannelMember.channel_id == channel_id) & (ChannelMember.user_id == payload.user_id)
        )
    )
    member = result.scalar_one_or_none()
    if member:
        await db.delete(member)

    ban = Ban(
        channel_id=channel_id,
        user_id=payload.user_id,
        reason=payload.reason,
        banned_by=current.id,
    )
    db.add(ban)
    await db.commit()
    await db.refresh(ban)
    return BanResponse.model_validate(ban)


@router.get("/{channel_id}/bans", response_model=list[BanResponse])
async def list_bans(
    channel_id: UUID,
    ctx=Depends(require_permission(Permission.BAN_MEMBERS)),
    db: AsyncSession = Depends(get_db),
) -> list[BanResponse]:
    result = await db.execute(select(Ban).where(Ban.channel_id == channel_id))
    return [BanResponse.model_validate(b) for b in result.scalars().all()]


@router.delete("/{channel_id}/bans/{user_id}", status_code=204)
async def unban_user(
    channel_id: UUID,
    user_id: UUID,
    ctx=Depends(require_permission(Permission.BAN_MEMBERS)),
    db: AsyncSession = Depends(get_db),
) -> None:
    result = await db.execute(
        select(Ban).where((Ban.channel_id == channel_id) & (Ban.user_id == user_id))
    )
    ban = result.scalar_one_or_none()
    if ban:
        await db.delete(ban)
        await db.commit()


# ---------- Invites ----------

@router.post("/{channel_id}/invites", response_model=InviteResponse, status_code=201)
async def create_invite(
    channel_id: UUID,
    payload: InviteCreate,
    current: CurrentUser = Depends(get_current_user),
    ctx=Depends(require_permission(Permission.CREATE_INVITE)),
    db: AsyncSession = Depends(get_db),
) -> InviteResponse:
    inv = Invite(
        code=_gen_invite_code(),
        channel_id=channel_id,
        created_by=current.id,
        expires_at=datetime.now(timezone.utc) + timedelta(seconds=payload.ttl_seconds),
        max_uses=payload.max_uses,
    )
    db.add(inv)
    await db.commit()
    await db.refresh(inv)
    return InviteResponse.model_validate(inv)


@invites_router.get("/{code}", response_model=InviteResponse)
async def get_invite(code: str, db: AsyncSession = Depends(get_db)) -> InviteResponse:
    result = await db.execute(select(Invite).where(Invite.code == code))
    inv = result.scalar_one_or_none()
    if not inv:
        raise HTTPException(404, "Invite not found")
    if _is_expired(inv.expires_at):
        raise HTTPException(410, "Invite expired")
    if inv.max_uses is not None and inv.uses >= inv.max_uses:
        raise HTTPException(410, "Invite exhausted")
    return InviteResponse.model_validate(inv)


@invites_router.post("/{code}/accept", response_model=InviteAcceptResponse)
async def accept_invite(
    code: str,
    current: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> InviteAcceptResponse:
    result = await db.execute(select(Invite).where(Invite.code == code))
    inv = result.scalar_one_or_none()
    if not inv:
        raise HTTPException(404, "Invite not found")
    if _is_expired(inv.expires_at):
        raise HTTPException(410, "Invite expired")
    if inv.max_uses is not None and inv.uses >= inv.max_uses:
        raise HTTPException(410, "Invite exhausted")

    # Check ban
    ban_result = await db.execute(
        select(Ban).where((Ban.channel_id == inv.channel_id) & (Ban.user_id == current.id))
    )
    if ban_result.scalar_one_or_none():
        raise HTTPException(403, "You are banned from this channel")

    # Already a member?
    existing = await db.execute(
        select(ChannelMember).where(
            (ChannelMember.channel_id == inv.channel_id) & (ChannelMember.user_id == current.id)
        )
    )
    member = existing.scalar_one_or_none()
    if member:
        return InviteAcceptResponse(channel_id=inv.channel_id, member_id=member.id)

    member = ChannelMember(channel_id=inv.channel_id, user_id=current.id)
    db.add(member)
    await db.flush()

    # Assign default role
    default_role_result = await db.execute(
        select(Role).where((Role.channel_id == inv.channel_id) & (Role.is_default == True))  # noqa: E712
    )
    default_role = default_role_result.scalar_one_or_none()
    if default_role:
        db.add(MemberRole(member_id=member.id, role_id=default_role.id))

    inv.uses += 1
    await db.commit()

    return InviteAcceptResponse(channel_id=inv.channel_id, member_id=member.id)
