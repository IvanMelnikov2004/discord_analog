"""Password hashing and refresh token utilities."""
import hashlib
import secrets

import bcrypt


def hash_password(password: str) -> str:
    """Hash a password with an auto-generated salt."""
    password_bytes = password.encode("utf-8")
    salt = bcrypt.gensalt()
    hashed_bytes = bcrypt.hashpw(password_bytes, salt)
    return hashed_bytes.decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    """Constant-time password verification."""
    try:
        return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))
    except Exception:
        # Hash corrupted or wrong format
        return False


def generate_refresh_token() -> tuple[str, str]:
    """Return (raw_token, sha256_hash). Store hash, send raw to client."""
    raw = secrets.token_urlsafe(48)
    h = hashlib.sha256(raw.encode()).hexdigest()
    return raw, h


def hash_refresh_token(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()
