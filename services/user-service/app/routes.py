from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.deps import get_current_user
from app.models import Friendship, UserProfile
from app.schemas import (
    FriendRequest,
    FriendshipResponse,
    ProfileCreate,
    ProfileResponse,
    ProfileUpdate,
)
from shared.deps import CurrentUser

router = APIRouter(prefix="/api/users", tags=["users"])


# Internal endpoint called by auth-service after registration.
# For MVP — open; in production guard with internal token or mTLS.
@router.post("/profile/init", response_model=ProfileResponse, status_code=201)
async def init_profile(payload: ProfileCreate, db: AsyncSession = Depends(get_db)) -> ProfileResponse:
    existing = await db.execute(select(UserProfile).where(UserProfile.user_id == payload.user_id))
    if existing.scalar_one_or_none():
        raise HTTPException(409, "Profile exists")
    p = UserProfile(user_id=payload.user_id, username=payload.username)
    db.add(p)
    await db.commit()
    await db.refresh(p)
    return ProfileResponse.model_validate(p)


@router.get("/me", response_model=ProfileResponse)
async def get_me(
    current: CurrentUser = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> ProfileResponse:
    result = await db.execute(select(UserProfile).where(UserProfile.user_id == current.id))
    profile = result.scalar_one_or_none()
    if not profile:
        raise HTTPException(404, "Profile not found")
    return ProfileResponse.model_validate(profile)


@router.patch("/me", response_model=ProfileResponse)
async def update_me(
    payload: ProfileUpdate,
    current: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ProfileResponse:
    result = await db.execute(select(UserProfile).where(UserProfile.user_id == current.id))
    profile = result.scalar_one_or_none()
    if not profile:
        raise HTTPException(404, "Profile not found")
    data = payload.model_dump(exclude_unset=True)
    for k, v in data.items():
        setattr(profile, k, v)
    await db.commit()
    await db.refresh(profile)
    return ProfileResponse.model_validate(profile)


@router.get("/{user_id}", response_model=ProfileResponse)
async def get_user(
    user_id: UUID,
    _: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ProfileResponse:
    result = await db.execute(select(UserProfile).where(UserProfile.user_id == user_id))
    profile = result.scalar_one_or_none()
    if not profile:
        raise HTTPException(404, "Not found")
    return ProfileResponse.model_validate(profile)


@router.get("/", response_model=list[ProfileResponse])
async def search(
    q: str = Query(min_length=2, max_length=50),
    _: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[ProfileResponse]:
    result = await db.execute(
        select(UserProfile).where(UserProfile.username.ilike(f"%{q}%")).limit(20)
    )
    return [ProfileResponse.model_validate(p) for p in result.scalars().all()]


# ---------- Friendships ----------

@router.post("/friends", response_model=FriendshipResponse, status_code=201)
async def send_friend_request(
    payload: FriendRequest,
    current: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> FriendshipResponse:
    if payload.target_user_id == current.id:
        raise HTTPException(400, "Cannot friend yourself")

    existing = await db.execute(
        select(Friendship).where(
            or_(
                (Friendship.requester_id == current.id) & (Friendship.addressee_id == payload.target_user_id),
                (Friendship.requester_id == payload.target_user_id) & (Friendship.addressee_id == current.id),
            )
        )
    )
    if existing.scalar_one_or_none():
        raise HTTPException(409, "Friendship already exists")

    fr = Friendship(requester_id=current.id, addressee_id=payload.target_user_id, status="pending")
    db.add(fr)
    await db.commit()
    await db.refresh(fr)
    return FriendshipResponse.model_validate(fr)


@router.post("/friends/{friendship_id}/accept", response_model=FriendshipResponse)
async def accept_friend(
    friendship_id: UUID,
    current: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> FriendshipResponse:
    result = await db.execute(select(Friendship).where(Friendship.id == friendship_id))
    fr = result.scalar_one_or_none()
    if not fr or fr.addressee_id != current.id:
        raise HTTPException(404, "Not found")
    fr.status = "accepted"
    await db.commit()
    await db.refresh(fr)
    return FriendshipResponse.model_validate(fr)


@router.get("/friends/list", response_model=list[FriendshipResponse])
async def list_friends(
    current: CurrentUser = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> list[FriendshipResponse]:
    result = await db.execute(
        select(Friendship).where(
            or_(Friendship.requester_id == current.id, Friendship.addressee_id == current.id)
        )
    )
    return [FriendshipResponse.model_validate(f) for f in result.scalars().all()]


@router.delete("/friends/{friendship_id}", status_code=204)
async def delete_friend(
    friendship_id: UUID,
    current: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    result = await db.execute(select(Friendship).where(Friendship.id == friendship_id))
    fr = result.scalar_one_or_none()
    if not fr or current.id not in (fr.requester_id, fr.addressee_id):
        raise HTTPException(404, "Not found")
    await db.delete(fr)
    await db.commit()
