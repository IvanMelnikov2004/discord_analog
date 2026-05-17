"""Common FastAPI dependencies."""
from uuid import UUID

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from shared.jwt_utils import TokenPayload, decode_token

bearer_scheme = HTTPBearer(auto_error=True)


class CurrentUser:
    """Holds authenticated user data extracted from JWT."""

    def __init__(self, id: UUID):
        self.id = id


def make_current_user_dependency(secret_key: str, algorithm: str):
    """Factory that returns a FastAPI dependency capturing JWT config."""

    async def get_current_user(
        creds: HTTPAuthorizationCredentials = Depends(bearer_scheme),
    ) -> CurrentUser:
        try:
            payload: TokenPayload = decode_token(creds.credentials, secret_key, algorithm)
        except ValueError as e:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail=str(e),
                headers={"WWW-Authenticate": "Bearer"},
            ) from e

        if payload.type != "access":
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Wrong token type",
            )

        try:
            user_id = UUID(payload.sub)
        except ValueError as e:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid token subject",
            ) from e

        return CurrentUser(id=user_id)

    return get_current_user
