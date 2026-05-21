"""Tests for shared.jwt_utils — token creation and validation."""
import time
from uuid import uuid4

import pytest

from shared.jwt_utils import (
    create_access_token,
    create_refresh_token,
    decode_token,
)

SECRET = "test_secret_key_at_least_64_chars_long_for_safety_xxxxxxxxxxxxxxxx"
ALGO = "HS256"


def test_access_token_round_trip(capsys):
    user_id = uuid4()
    token = create_access_token(user_id, SECRET, ALGO, 30)
    print(f"\n[test] issued access token (len={len(token)})")
    payload = decode_token(token, SECRET, ALGO)
    assert payload.sub == str(user_id)
    assert payload.type == "access"
    assert payload.exp > payload.iat


def test_refresh_token_has_correct_type():
    user_id = uuid4()
    token = create_refresh_token(user_id, SECRET, ALGO, 14)
    payload = decode_token(token, SECRET, ALGO)
    print(f"\n[test] refresh token type = {payload.type}")
    assert payload.type == "refresh"


def test_bad_signature_rejected():
    user_id = uuid4()
    token = create_access_token(user_id, SECRET, ALGO, 30)
    print("\n[test] decoding with wrong secret must fail")
    with pytest.raises(ValueError):
        decode_token(token, "wrong_secret_at_least_64_chars_xxxxxxxxxxxxxxxxxxxxxxxxxxx", ALGO)


def test_garbage_token_rejected():
    print("\n[test] non-JWT string must fail")
    with pytest.raises(ValueError):
        decode_token("not.a.real.token", SECRET, ALGO)


def test_expired_token_rejected():
    """Negative expiry should still encode but decoding should fail."""
    user_id = uuid4()
    # 0-minute expiry — already expired
    token = create_access_token(user_id, SECRET, ALGO, 0)
    time.sleep(1.1)
    print("\n[test] expired token must fail decoding")
    with pytest.raises(ValueError):
        decode_token(token, SECRET, ALGO)
