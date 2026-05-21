"""Tests for shared.permissions — Discord-style bitmask permissions."""
import pytest

from shared.permissions import Permission, has_permission


def test_default_member_has_basic_perms(capsys):
    perms = Permission.default_member()
    print(f"\n[test] default_member bitmask = {perms:b}")
    assert has_permission(perms, Permission.VIEW_CHANNEL)
    assert has_permission(perms, Permission.SEND_MESSAGES)
    assert has_permission(perms, Permission.CONNECT_VOICE)


def test_default_member_lacks_admin_perms():
    perms = Permission.default_member()
    print(f"\n[test] default_member should NOT manage roles")
    assert not has_permission(perms, Permission.BAN_MEMBERS)
    assert not has_permission(perms, Permission.MANAGE_ROLES)
    assert not has_permission(perms, Permission.MANAGE_CHANNELS)


def test_admin_overrides_everything():
    """ADMINISTRATOR flag implies every other permission."""
    admin = Permission.admin()
    print(f"\n[test] admin bitmask = {admin:b}")
    # Admin should pass any check, even ones not OR'd into the mask
    for p in [
        Permission.BAN_MEMBERS,
        Permission.MANAGE_ROLES,
        Permission.MANAGE_CHANNELS,
        Permission.KICK_MEMBERS,
        Permission.MUTE_MEMBERS,
        Permission.CREATE_INVITE,
    ]:
        assert has_permission(admin, p), f"admin should imply {p.name}"


def test_or_combination():
    """OR'ing two role bitmasks gives the union of permissions."""
    moderator = int(Permission.KICK_MEMBERS | Permission.MUTE_MEMBERS)
    default = Permission.default_member()
    combined = moderator | default
    print(f"\n[test] mod({moderator:b}) | default({default:b}) = {combined:b}")
    assert has_permission(combined, Permission.SEND_MESSAGES)
    assert has_permission(combined, Permission.KICK_MEMBERS)
    assert has_permission(combined, Permission.MUTE_MEMBERS)
    assert not has_permission(combined, Permission.BAN_MEMBERS)


def test_zero_permissions_grants_nothing():
    print("\n[test] empty bitmask should grant no permissions")
    for p in Permission:
        if p == Permission.NONE:
            continue
        assert not has_permission(0, p)
