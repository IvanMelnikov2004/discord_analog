"""Tests for channel-service business logic."""
from uuid import uuid4

import pytest

from shared.jwt_utils import create_access_token

SECRET = "x" * 64


def auth_header(user_id) -> dict:
    token = create_access_token(user_id, SECRET, "HS256", 30)
    return {"Authorization": f"Bearer {token}"}


@pytest.mark.asyncio
async def test_create_channel_seeds_default_role_and_rooms(client):
    print("\n[test] creating a channel auto-creates @everyone, Admin, #general, voice room")
    user = uuid4()
    r = await client.post(
        "/api/channels",
        json={"name": "My Server", "description": "for testing"},
        headers=auth_header(user),
    )
    print(f"  create status={r.status_code}, body={r.json()}")
    assert r.status_code == 201
    channel_id = r.json()["id"]

    rooms = await client.get(f"/api/channels/{channel_id}/rooms", headers=auth_header(user))
    assert rooms.status_code == 200
    room_names = sorted(rm["name"] for rm in rooms.json())
    print(f"  rooms={room_names}")
    assert "general" in room_names
    assert any(rm["room_type"] == "voice" for rm in rooms.json())

    roles = await client.get(f"/api/channels/{channel_id}/roles", headers=auth_header(user))
    role_names = sorted(rl["name"] for rl in roles.json())
    print(f"  roles={role_names}")
    assert "@everyone" in role_names
    assert "Admin" in role_names


@pytest.mark.asyncio
async def test_non_member_cannot_see_channel(client):
    print("\n[test] non-member rejected with 403")
    owner = uuid4()
    outsider = uuid4()
    r = await client.post("/api/channels", json={"name": "Private"}, headers=auth_header(owner))
    assert r.status_code == 201
    channel_id = r.json()["id"]

    r2 = await client.get(f"/api/channels/{channel_id}", headers=auth_header(outsider))
    print(f"  outsider status={r2.status_code}")
    assert r2.status_code == 403


@pytest.mark.asyncio
async def test_invite_flow(client):
    print("\n[test] full invite flow: create -> get -> accept")
    owner = uuid4()
    joiner = uuid4()

    ch = await client.post("/api/channels", json={"name": "Inviting"}, headers=auth_header(owner))
    assert ch.status_code == 201
    channel_id = ch.json()["id"]

    inv = await client.post(
        f"/api/channels/{channel_id}/invites",
        json={"ttl_seconds": 3600},
        headers=auth_header(owner),
    )
    assert inv.status_code == 201
    code = inv.json()["code"]
    print(f"  invite code={code}")

    look = await client.get(f"/api/invites/{code}")
    assert look.status_code == 200

    acc = await client.post(f"/api/invites/{code}/accept", headers=auth_header(joiner))
    print(f"  accept status={acc.status_code}")
    assert acc.status_code == 200
    assert acc.json()["channel_id"] == channel_id

    seen = await client.get(f"/api/channels/{channel_id}", headers=auth_header(joiner))
    assert seen.status_code == 200


@pytest.mark.asyncio
async def test_ban_prevents_invite_acceptance(client):
    print("\n[test] banned user cannot accept invite")
    owner = uuid4()
    bad = uuid4()

    ch = await client.post("/api/channels", json={"name": "Banhammer"}, headers=auth_header(owner))
    assert ch.status_code == 201
    channel_id = ch.json()["id"]

    ban = await client.post(
        f"/api/channels/{channel_id}/bans",
        json={"user_id": str(bad), "reason": "spam"},
        headers=auth_header(owner),
    )
    print(f"  ban status={ban.status_code}")
    assert ban.status_code == 201

    inv = await client.post(
        f"/api/channels/{channel_id}/invites",
        json={"ttl_seconds": 3600},
        headers=auth_header(owner),
    )
    code = inv.json()["code"]

    acc = await client.post(f"/api/invites/{code}/accept", headers=auth_header(bad))
    print(f"  banned accept status={acc.status_code}")
    assert acc.status_code == 403


@pytest.mark.asyncio
async def test_non_admin_cannot_create_room(client):
    print("\n[test] regular member cannot create rooms")
    owner = uuid4()
    member = uuid4()

    ch = await client.post("/api/channels", json={"name": "S"}, headers=auth_header(owner))
    assert ch.status_code == 201
    channel_id = ch.json()["id"]
    inv = await client.post(
        f"/api/channels/{channel_id}/invites",
        json={"ttl_seconds": 3600},
        headers=auth_header(owner),
    )
    await client.post(f"/api/invites/{inv.json()['code']}/accept", headers=auth_header(member))

    r = await client.post(
        f"/api/channels/{channel_id}/rooms",
        json={"name": "secret", "room_type": "text"},
        headers=auth_header(member),
    )
    print(f"  status={r.status_code}")
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_owner_can_kick_member(client):
    print("\n[test] owner kicks member")
    owner = uuid4()
    member = uuid4()
    ch = await client.post("/api/channels", json={"name": "K"}, headers=auth_header(owner))
    assert ch.status_code == 201
    channel_id = ch.json()["id"]
    inv = await client.post(
        f"/api/channels/{channel_id}/invites",
        json={"ttl_seconds": 3600},
        headers=auth_header(owner),
    )
    accept = await client.post(f"/api/invites/{inv.json()['code']}/accept", headers=auth_header(member))
    member_id = accept.json()["member_id"]

    kick = await client.delete(
        f"/api/channels/{channel_id}/members/{member_id}",
        headers=auth_header(owner),
    )
    print(f"  kick status={kick.status_code}")
    assert kick.status_code == 204

    seen = await client.get(f"/api/channels/{channel_id}", headers=auth_header(member))
    print(f"  kicked member access status={seen.status_code}")
    assert seen.status_code == 403


@pytest.mark.asyncio
async def test_invite_with_too_short_ttl_rejected_by_schema(client):
    print("\n[test] invite with ttl<60s rejected by validation (422)")
    owner = uuid4()
    ch = await client.post("/api/channels", json={"name": "TTL"}, headers=auth_header(owner))
    assert ch.status_code == 201
    channel_id = ch.json()["id"]

    r = await client.post(
        f"/api/channels/{channel_id}/invites",
        json={"ttl_seconds": 1},
        headers=auth_header(owner),
    )
    print(f"  status={r.status_code}")
    assert r.status_code == 422


# ---------- Role hierarchy integration ----------

async def _make_channel_with_member(client, owner, member):
    """Helper: create channel, join `member` via invite. Returns (channel_id, member_id)."""
    ch = await client.post("/api/channels", json={"name": "Hier"}, headers=auth_header(owner))
    channel_id = ch.json()["id"]
    inv = await client.post(
        f"/api/channels/{channel_id}/invites",
        json={"ttl_seconds": 3600},
        headers=auth_header(owner),
    )
    acc = await client.post(f"/api/invites/{inv.json()['code']}/accept", headers=auth_header(member))
    return channel_id, acc.json()["member_id"]


@pytest.mark.asyncio
async def test_member_cannot_ban_owner(client):
    print("\n[test] a regular member cannot ban the owner (hierarchy + perms)")
    owner = uuid4()
    member = uuid4()
    channel_id, _ = await _make_channel_with_member(client, owner, member)

    # Member has only @everyone (no BAN_MEMBERS) -> should be 403
    r = await client.post(
        f"/api/channels/{channel_id}/bans",
        json={"user_id": str(owner)},
        headers=auth_header(member),
    )
    print(f"  member-bans-owner status={r.status_code}")
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_owner_cannot_ban_self(client):
    print("\n[test] owner cannot ban themselves")
    owner = uuid4()
    ch = await client.post("/api/channels", json={"name": "Self"}, headers=auth_header(owner))
    channel_id = ch.json()["id"]
    r = await client.post(
        f"/api/channels/{channel_id}/bans",
        json={"user_id": str(owner)},
        headers=auth_header(owner),
    )
    print(f"  status={r.status_code}")
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_my_permissions_owner_is_admin(client):
    print("\n[test] /me/permissions reports owner as admin")
    owner = uuid4()
    ch = await client.post("/api/channels", json={"name": "Perms"}, headers=auth_header(owner))
    channel_id = ch.json()["id"]

    r = await client.get(f"/api/channels/{channel_id}/me/permissions", headers=auth_header(owner))
    assert r.status_code == 200
    body = r.json()
    print(f"  is_owner={body['is_owner']} is_admin={body['is_admin']}")
    assert body["is_owner"] is True
    assert body["is_admin"] is True
    assert "BAN_MEMBERS" in body["names"]


@pytest.mark.asyncio
async def test_my_permissions_regular_member(client):
    print("\n[test] /me/permissions for a plain member lacks moderation rights")
    owner = uuid4()
    member = uuid4()
    channel_id, _ = await _make_channel_with_member(client, owner, member)

    r = await client.get(f"/api/channels/{channel_id}/me/permissions", headers=auth_header(member))
    assert r.status_code == 200
    body = r.json()
    print(f"  names={body['names']}")
    assert body["is_owner"] is False
    assert body["is_admin"] is False
    assert "SEND_MESSAGES" in body["names"]
    assert "BAN_MEMBERS" not in body["names"]


@pytest.mark.asyncio
async def test_assign_and_list_member_roles(client):
    print("\n[test] owner creates a role, assigns it, and it shows in member roles")
    owner = uuid4()
    member = uuid4()
    channel_id, member_id = await _make_channel_with_member(client, owner, member)

    # Create a moderator role
    role = await client.post(
        f"/api/channels/{channel_id}/roles",
        json={"name": "Moderator", "permissions": 0},
        headers=auth_header(owner),
    )
    assert role.status_code == 201
    role_id = role.json()["id"]

    # Assign it to the member
    assign = await client.post(
        f"/api/channels/{channel_id}/members/{member_id}/roles",
        json={"role_id": role_id},
        headers=auth_header(owner),
    )
    print(f"  assign status={assign.status_code}")
    assert assign.status_code == 204

    # The member's role list should now include it
    listed = await client.get(
        f"/api/channels/{channel_id}/members/{member_id}/roles",
        headers=auth_header(owner),
    )
    assert listed.status_code == 200
    print(f"  member roles={listed.json()}")
    assert role_id in listed.json()

    # Revoke and confirm it's gone
    revoke = await client.delete(
        f"/api/channels/{channel_id}/members/{member_id}/roles/{role_id}",
        headers=auth_header(owner),
    )
    assert revoke.status_code == 204
    listed2 = await client.get(
        f"/api/channels/{channel_id}/members/{member_id}/roles",
        headers=auth_header(owner),
    )
    assert role_id not in listed2.json()
