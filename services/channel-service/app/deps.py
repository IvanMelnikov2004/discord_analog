from uuid import UUID

from fastapi import Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db import get_db
from app.models import ChannelMember, MemberRole, Role
from shared.deps import CurrentUser, make_current_user_dependency
from shared.permissions import Permission, has_permission

_s = get_settings()
get_current_user = make_current_user_dependency(_s.JWT_SECRET_KEY, _s.JWT_ALGORITHM)


async def get_member_permissions(
    db: AsyncSession, channel_id: UUID, user_id: UUID
) -> tuple[ChannelMember, int]:
    """Return member + computed effective permissions (OR of all role bitmasks)."""
    member_result = await db.execute(
        select(ChannelMember).where(
            (ChannelMember.channel_id == channel_id) & (ChannelMember.user_id == user_id)
        )
    )
    member = member_result.scalar_one_or_none()
    if member is None:
        raise HTTPException(403, "Not a member of this channel")

    role_result = await db.execute(
        select(Role)
        .join(MemberRole, MemberRole.role_id == Role.id)
        .where(MemberRole.member_id == member.id)
    )
    roles = role_result.scalars().all()

    perms = 0
    for r in roles:
        perms |= r.permissions
    return member, perms


def require_permission(perm: Permission):
    """Dependency factory: ensure caller has `perm` in given channel."""

    async def checker(
        channel_id: UUID,
        current: CurrentUser = Depends(get_current_user),
        db: AsyncSession = Depends(get_db),
    ) -> tuple[ChannelMember, int]:
        member, perms = await get_member_permissions(db, channel_id, current.id)
        if not has_permission(perms, perm):
            raise HTTPException(403, f"Missing permission: {perm.name}")
        return member, perms

    return checker
