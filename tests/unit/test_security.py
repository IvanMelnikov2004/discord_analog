"""Tests for auth-service password hashing utilities."""
from app.security import (
    generate_refresh_token,
    hash_password,
    hash_refresh_token,
    verify_password,
)


def test_password_hash_is_not_plaintext():
    print("\n[test] hash is different from plaintext")
    h = hash_password("hunter2hunter2")
    print(f"  hash prefix={h[:7]}...")
    assert h != "hunter2hunter2"
    assert h.startswith("$2")  # bcrypt format identifier


def test_password_verify_correct():
    h = hash_password("correct horse battery staple")
    print("\n[test] correct password verifies")
    assert verify_password("correct horse battery staple", h)


def test_password_verify_wrong():
    h = hash_password("correct horse battery staple")
    print("\n[test] wrong password fails verification")
    assert not verify_password("wrong password", h)


def test_password_verify_garbage_hash():
    print("\n[test] malformed hash returns False, not crash")
    assert verify_password("anything", "not-a-real-hash") is False


def test_each_hash_is_unique():
    print("\n[test] same plaintext -> different hashes (different salt)")
    a = hash_password("same")
    b = hash_password("same")
    assert a != b
    assert verify_password("same", a)
    assert verify_password("same", b)


def test_refresh_token_pair():
    print("\n[test] refresh token: raw + sha256 hash")
    raw, h = generate_refresh_token()
    print(f"  raw_len={len(raw)} hash_len={len(h)}")
    assert len(raw) > 40
    assert len(h) == 64
    assert hash_refresh_token(raw) == h


def test_refresh_tokens_are_unique():
    a, _ = generate_refresh_token()
    b, _ = generate_refresh_token()
    print("\n[test] two refresh tokens should differ")
    assert a != b
