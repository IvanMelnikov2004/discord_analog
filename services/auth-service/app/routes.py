from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db import get_db
from app.deps import get_current_user
from app.models import PublicKey, RefreshToken, User
from app.schemas import (
    LoginRequest,
    PublicKeyResponse,
    PublicKeyUpload,
    RefreshRequest,
    RegisterRequest,
    TokenResponse,
    UserResponse,
)
from app.security import (
    generate_refresh_token,
    hash_password,
    hash_refresh_token,
    verify_password,
)
from shared.deps import CurrentUser
from shared.jwt_utils import create_access_token

router = APIRouter(prefix="/api/auth", tags=["auth"])
settings = get_settings()


async def _issue_tokens(user_id, db: AsyncSession) -> TokenResponse:
    access = create_access_token(
        user_id,
        settings.JWT_SECRET_KEY,
        settings.JWT_ALGORITHM,
        settings.JWT_ACCESS_TOKEN_EXPIRE_MINUTES,
    )
    raw_refresh, refresh_hash = generate_refresh_token()
    expires_at = datetime.now(timezone.utc) + timedelta(days=settings.JWT_REFRESH_TOKEN_EXPIRE_DAYS)
    db.add(RefreshToken(user_id=user_id, token_hash=refresh_hash, expires_at=expires_at))
    await db.commit()
    return TokenResponse(access_token=access, refresh_token=raw_refresh)


@router.post("/register", response_model=TokenResponse, status_code=status.HTTP_201_CREATED)
async def register(payload: RegisterRequest, db: AsyncSession = Depends(get_db)) -> TokenResponse:
    existing = await db.execute(
        select(User).where((User.email == payload.email) | (User.username == payload.username))
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Email or username already taken")

    user = User(
        email=payload.email,
        username=payload.username,
        password_hash=hash_password(payload.password),
    )
    db.add(user)
    await db.flush()
    return await _issue_tokens(user.id, db)


@router.post("/login", response_model=TokenResponse)
async def login(payload: LoginRequest, db: AsyncSession = Depends(get_db)) -> TokenResponse:
    result = await db.execute(select(User).where(User.email == payload.email))
    user = result.scalar_one_or_none()
    if not user or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    if not user.is_active:
        raise HTTPException(status_code=403, detail="User is disabled")
    return await _issue_tokens(user.id, db)


@router.post("/refresh", response_model=TokenResponse)
async def refresh(payload: RefreshRequest, db: AsyncSession = Depends(get_db)) -> TokenResponse:
    token_hash = hash_refresh_token(payload.refresh_token)
    result = await db.execute(select(RefreshToken).where(RefreshToken.token_hash == token_hash))
    token_row = result.scalar_one_or_none()

    if (
        token_row is None
        or token_row.revoked
        or token_row.expires_at < datetime.now(timezone.utc)
    ):
        raise HTTPException(status_code=401, detail="Invalid refresh token")

    # Rotate: revoke old, issue new pair
    token_row.revoked = True
    await db.flush()
    return await _issue_tokens(token_row.user_id, db)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(payload: RefreshRequest, db: AsyncSession = Depends(get_db)) -> None:
    token_hash = hash_refresh_token(payload.refresh_token)
    result = await db.execute(select(RefreshToken).where(RefreshToken.token_hash == token_hash))
    token_row = result.scalar_one_or_none()
    if token_row:
        token_row.revoked = True
        await db.commit()


@router.get("/me", response_model=UserResponse)
async def me(
    current: CurrentUser = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> UserResponse:
    result = await db.execute(select(User).where(User.id == current.id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return UserResponse.model_validate(user)


# ---------- Public keys ----------

@router.post("/keys", response_model=PublicKeyResponse, status_code=status.HTTP_201_CREATED)
async def upload_public_key(
    payload: PublicKeyUpload,
    current: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PublicKeyResponse:
    """Replace existing key of this type for the user."""
    await db.execute(
        select(PublicKey).where(
            (PublicKey.user_id == current.id) & (PublicKey.key_type == payload.key_type)
        )
    )
    # delete old keys of this type
    result = await db.execute(
        select(PublicKey).where(
            (PublicKey.user_id == current.id) & (PublicKey.key_type == payload.key_type)
        )
    )
    for old in result.scalars().all():
        await db.delete(old)

    key = PublicKey(user_id=current.id, key_type=payload.key_type, key_data=payload.key_data)
    db.add(key)
    await db.commit()
    await db.refresh(key)
    return PublicKeyResponse.model_validate(key)


@router.get("/keys/{user_id}", response_model=list[PublicKeyResponse])
async def get_public_keys(
    user_id: str,
    _: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[PublicKeyResponse]:
    result = await db.execute(select(PublicKey).where(PublicKey.user_id == user_id))
    return [PublicKeyResponse.model_validate(k) for k in result.scalars().all()]
