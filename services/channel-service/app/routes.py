import secrets
import string
from datetime import datetime, timedelta, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.deps import (
    get_current_user,
    get_member_context,
    get_member_permissions,
    get_target_rank,
    is_member_currently_muted,
    publish_user_event,
    require_permission,
)
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
    MyPermissionsResponse,
    RoleCreate,
    RoleResponse,
    RoleUpdate,
    RoomCreate,
    RoomResponse,
)
from shared.deps import CurrentUser
from shared.permissions import (
    Permission,
    can_act_on,
    can_manage_role,
    has_permission,
)

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


@router.get("/{channel_id}/me/permissions", response_model=MyPermissionsResponse)
async def my_permissions(
    channel_id: UUID,
    current: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> MyPermissionsResponse:
    """Effective permissions of the caller in this channel.

    The frontend uses this to decide which moderation controls to render.
    """
    ctx = await get_member_context(db, channel_id, current.id)
    granted = [
        p.name
        for p in Permission
        if p not in (Permission.NONE,) and (ctx.permissions & p)
    ]
    # Refresh the mute flag (also clears it if a timed mute just expired).
    muted_now = await is_member_currently_muted(db, ctx.member)
    return MyPermissionsResponse(
        channel_id=channel_id,
        permissions=ctx.permissions,
        rank=ctx.rank,
        is_owner=ctx.is_owner,
        is_admin=bool(ctx.permissions & Permission.ADMINISTRATOR),
        names=granted,
        muted=muted_now,
        muted_until=ctx.member.muted_until if muted_now else None,
    )


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


@router.get("/{channel_id}/members/{member_id}/roles", response_model=list[str])
async def list_member_roles(
    channel_id: UUID,
    member_id: UUID,
    current: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[str]:
    """Return the IDs of roles assigned to a member (for the role-management UI)."""
    await get_member_permissions(db, channel_id, current.id)
    # Ensure the member belongs to this channel
    member_result = await db.execute(
        select(ChannelMember).where(
            (ChannelMember.id == member_id) & (ChannelMember.channel_id == channel_id)
        )
    )
    if not member_result.scalar_one_or_none():
        raise HTTPException(404, "Member not found")

    role_result = await db.execute(
        select(Role.id)
        .join(MemberRole, MemberRole.role_id == Role.id)
        .where(MemberRole.member_id == member_id)
    )
    return [str(rid) for rid in role_result.scalars().all()]


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
    member = member_result.scalar_one_or_none()
    if not member:
        raise HTTPException(404, "Member not found")

    role_result = await db.execute(
        select(Role).where((Role.id == payload.role_id) & (Role.channel_id == channel_id))
    )
    role = role_result.scalar_one_or_none()
    if not role:
        raise HTTPException(404, "Role not found")

    # Anti-escalation: you cannot grant a role at or above your own rank.
    if not can_manage_role(ctx.rank, role.position, ctx.is_owner):
        raise HTTPException(403, "Cannot assign a role equal to or above your own")

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
    await publish_user_event(
        member.user_id,
        "user.role_assigned",
        {
            "channel_id": str(channel_id),
            "role_id": str(payload.role_id),
            "role_name": role.name,
        },
    )


@router.delete("/{channel_id}/members/{member_id}/roles/{role_id}", status_code=204)
async def revoke_role(
    channel_id: UUID,
    member_id: UUID,
    role_id: UUID,
    ctx=Depends(require_permission(Permission.MANAGE_ROLES)),
    db: AsyncSession = Depends(get_db),
) -> None:
    # Anti-escalation: you cannot strip a role at or above your own rank.
    role_result = await db.execute(
        select(Role).where((Role.id == role_id) & (Role.channel_id == channel_id))
    )
    role = role_result.scalar_one_or_none()
    if role and not can_manage_role(ctx.rank, role.position, ctx.is_owner):
        raise HTTPException(403, "Cannot remove a role equal to or above your own")

    result = await db.execute(
        select(MemberRole).where(
            (MemberRole.member_id == member_id) & (MemberRole.role_id == role_id)
        )
    )
    mr = result.scalar_one_or_none()
    if mr:
        await db.delete(mr)
        await db.commit()
        # Look up the affected user so we can notify them.
        member_q = await db.execute(
            select(ChannelMember).where(ChannelMember.id == member_id)
        )
        affected = member_q.scalar_one_or_none()
        if affected:
            await publish_user_event(
                affected.user_id,
                "user.role_revoked",
                {"channel_id": str(channel_id), "role_id": str(role_id)},
            )


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

    # Hierarchy: can't kick someone whose rank is >= yours (or the owner).
    target_rank, target_is_owner = await get_target_rank(db, channel_id, member)
    if not can_act_on(ctx.rank, target_rank, ctx.is_owner, target_is_owner):
        raise HTTPException(403, "Cannot kick a member with an equal or higher role")

    kicked_user_id = member.user_id
    await db.delete(member)
    await db.commit()
    await publish_user_event(
        kicked_user_id, "user.kicked", {"channel_id": str(channel_id)}
    )
    # Tell everyone still in the channel that the roster shrank, so their
    # right-side member list updates without a refresh.
    remaining_q = await db.execute(
        select(ChannelMember.user_id).where(
            ChannelMember.channel_id == channel_id
        )
    )
    for uid in remaining_q.scalars().all():
        await publish_user_event(
            uid,
            "member.left",
            {"channel_id": str(channel_id), "user_id": str(kicked_user_id)},
        )


@router.patch("/{channel_id}/members/{member_id}/mute", status_code=204)
async def mute_member(
    channel_id: UUID,
    member_id: UUID,
    muted: bool = True,
    duration_seconds: int | None = None,
    ctx=Depends(require_permission(Permission.MUTE_MEMBERS)),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Mute or unmute a member.

    Query params:
      - muted: true to mute, false to unmute.
      - duration_seconds: when muting, how long. Omit for a permanent mute.
        Ignored when muted=false.
    """
    result = await db.execute(
        select(ChannelMember).where(
            (ChannelMember.id == member_id) & (ChannelMember.channel_id == channel_id)
        )
    )
    member = result.scalar_one_or_none()
    if not member:
        raise HTTPException(404, "Not found")

    target_rank, target_is_owner = await get_target_rank(db, channel_id, member)
    if not can_act_on(ctx.rank, target_rank, ctx.is_owner, target_is_owner):
        raise HTTPException(403, "Cannot mute a member with an equal or higher role")

    if muted:
        member.muted = True
        if duration_seconds and duration_seconds > 0:
            from datetime import datetime as _dt, timedelta as _td, timezone as _tz
            member.muted_until = _dt.now(_tz.utc) + _td(seconds=duration_seconds)
        else:
            member.muted_until = None  # forever
    else:
        member.muted = False
        member.muted_until = None
    await db.commit()

    # Notify the affected user so their client can update without reload.
    await publish_user_event(
        member.user_id,
        "user.muted" if muted else "user.unmuted",
        {
            "channel_id": str(channel_id),
            "muted": member.muted,
            "muted_until": member.muted_until.isoformat() if member.muted_until else None,
        },
    )


# ---------- Bans ----------

@router.post("/{channel_id}/bans", response_model=BanResponse, status_code=201)
async def ban_user(
    channel_id: UUID,
    payload: BanCreate,
    current: CurrentUser = Depends(get_current_user),
    ctx=Depends(require_permission(Permission.BAN_MEMBERS)),
    db: AsyncSession = Depends(get_db),
) -> BanResponse:
    # Can't ban yourself
    if payload.user_id == current.id:
        raise HTTPException(400, "You cannot ban yourself")

    # If the target is a member, enforce hierarchy before banning.
    result = await db.execute(
        select(ChannelMember).where(
            (ChannelMember.channel_id == channel_id) & (ChannelMember.user_id == payload.user_id)
        )
    )
    member = result.scalar_one_or_none()
    if member:
        target_rank, target_is_owner = await get_target_rank(db, channel_id, member)
        if not can_act_on(ctx.rank, target_rank, ctx.is_owner, target_is_owner):
            raise HTTPException(403, "Cannot ban a member with an equal or higher role")
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
    await publish_user_event(
        payload.user_id,
        "user.banned",
        {"channel_id": str(channel_id), "reason": payload.reason},
    )
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

    # Notify every existing member that someone joined, so their clients can
    # re-distribute their per-room sender keys to the newcomer. The new user
    # is implicitly notified by their own user channel (auto-subscribed).
    existing_q = await db.execute(
        select(ChannelMember.user_id).where(
            (ChannelMember.channel_id == inv.channel_id)
            & (ChannelMember.user_id != current.id)
        )
    )
    for uid in existing_q.scalars().all():
        await publish_user_event(
            uid,
            "member.joined",
            {"channel_id": str(inv.channel_id), "user_id": str(current.id)},
        )

    return InviteAcceptResponse(channel_id=inv.channel_id, member_id=member.id)
