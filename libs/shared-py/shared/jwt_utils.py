"""JWT token utilities."""
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import UUID

from jose import JWTError, jwt
from pydantic import BaseModel


class TokenPayload(BaseModel):
    sub: str  # user id (UUID string)
    type: str  # "access" | "refresh"
    exp: int
    iat: int


def create_token(
    user_id: UUID | str,
    secret_key: str,
    algorithm: str,
    expires_minutes: int,
    token_type: str = "access",
) -> str:
    now = datetime.now(timezone.utc)
    expire = now + timedelta(minutes=expires_minutes)
    payload: dict[str, Any] = {
        "sub": str(user_id),
        "type": token_type,
        "iat": int(now.timestamp()),
        "exp": int(expire.timestamp()),
    }
    return jwt.encode(payload, secret_key, algorithm=algorithm)


def decode_token(token: str, secret_key: str, algorithm: str) -> TokenPayload:
    try:
        decoded = jwt.decode(token, secret_key, algorithms=[algorithm])
        return TokenPayload(**decoded)
    except (JWTError, ValueError) as e:
        raise ValueError(f"Invalid token: {e}") from e


def create_access_token(user_id: UUID | str, secret_key: str, algorithm: str, expires_minutes: int) -> str:
    return create_token(user_id, secret_key, algorithm, expires_minutes, "access")


def create_refresh_token(user_id: UUID | str, secret_key: str, algorithm: str, expires_days: int) -> str:
    return create_token(user_id, secret_key, algorithm, expires_days * 24 * 60, "refresh")
