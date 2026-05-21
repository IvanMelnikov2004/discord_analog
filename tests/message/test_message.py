"""Tests for message-service business logic."""
from uuid import uuid4

import pytest

from shared.jwt_utils import create_access_token

SECRET = "x" * 64


def auth_header(user_id) -> dict:
    token = create_access_token(user_id, SECRET, "HS256", 30)
    return {"Authorization": f"Bearer {token}"}


@pytest.mark.asyncio
async def test_send_room_message(client):
    print("\n[test] send a room message and read it back")
    user = uuid4()
    room = uuid4()
    r = await client.post(
        "/api/messages",
        json={"room_id": str(room), "ciphertext": "enc:hello"},
        headers=auth_header(user),
    )
    print(f"  send status={r.status_code}, body={r.json()}")
    assert r.status_code == 201
    body = r.json()
    assert body["ciphertext"] == "enc:hello"
    assert body["room_id"] == str(room)
    assert body["sender_id"] == str(user)


@pytest.mark.asyncio
async def test_list_room_messages_ordered(client):
    print("\n[test] history returned in chronological order")
    user = uuid4()
    room = uuid4()
    for i in range(3):
        r = await client.post(
            "/api/messages",
            json={"room_id": str(room), "ciphertext": f"enc:msg{i}"},
            headers=auth_header(user),
        )
        assert r.status_code == 201

    r = await client.get(f"/api/messages/room/{room}", headers=auth_header(user))
    assert r.status_code == 200
    msgs = r.json()
    print(f"  got {len(msgs)} messages")
    assert len(msgs) == 3
    assert msgs[0]["ciphertext"] == "enc:msg0"
    assert msgs[-1]["ciphertext"] == "enc:msg2"


@pytest.mark.asyncio
async def test_reject_both_room_and_recipient(client):
    print("\n[test] cannot specify both room_id and recipient_id")
    user = uuid4()
    r = await client.post(
        "/api/messages",
        json={
            "room_id": str(uuid4()),
            "recipient_id": str(uuid4()),
            "ciphertext": "x",
        },
        headers=auth_header(user),
    )
    print(f"  status={r.status_code}")
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_reject_neither_room_nor_recipient(client):
    print("\n[test] must specify either room or recipient")
    user = uuid4()
    r = await client.post(
        "/api/messages",
        json={"ciphertext": "x"},
        headers=auth_header(user),
    )
    print(f"  status={r.status_code}")
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_dm_pair_canonical(client):
    """Both directions of a DM go to the same canonical pair."""
    print("\n[test] DM symmetric pair key")
    a, b = uuid4(), uuid4()

    r1 = await client.post(
        "/api/messages",
        json={"recipient_id": str(b), "ciphertext": "enc:hi"},
        headers=auth_header(a),
    )
    assert r1.status_code == 201

    r2 = await client.post(
        "/api/messages",
        json={"recipient_id": str(a), "ciphertext": "enc:back"},
        headers=auth_header(b),
    )
    assert r2.status_code == 201

    r_a = await client.get(f"/api/messages/dm/{b}", headers=auth_header(a))
    r_b = await client.get(f"/api/messages/dm/{a}", headers=auth_header(b))
    print(f"  a sees {len(r_a.json())} msgs, b sees {len(r_b.json())} msgs")
    assert len(r_a.json()) == 2
    assert len(r_b.json()) == 2


@pytest.mark.asyncio
async def test_delete_own_message(client):
    print("\n[test] sender can delete own message")
    user = uuid4()
    room = uuid4()
    sent = await client.post(
        "/api/messages",
        json={"room_id": str(room), "ciphertext": "enc:bye"},
        headers=auth_header(user),
    )
    assert sent.status_code == 201
    msg_id = sent.json()["id"]

    d = await client.delete(f"/api/messages/{msg_id}", headers=auth_header(user))
    print(f"  delete status={d.status_code}")
    assert d.status_code == 204

    rest = await client.get(f"/api/messages/room/{room}", headers=auth_header(user))
    assert rest.json() == []


@pytest.mark.asyncio
async def test_cannot_delete_others_message(client):
    print("\n[test] non-author cannot delete")
    author = uuid4()
    other = uuid4()
    room = uuid4()
    sent = await client.post(
        "/api/messages",
        json={"room_id": str(room), "ciphertext": "enc:mine"},
        headers=auth_header(author),
    )
    assert sent.status_code == 201
    msg_id = sent.json()["id"]

    d = await client.delete(f"/api/messages/{msg_id}", headers=auth_header(other))
    print(f"  status={d.status_code}")
    assert d.status_code == 403


@pytest.mark.asyncio
async def test_unauthenticated_send_rejected(client):
    print("\n[test] no token -> 401/403")
    r = await client.post(
        "/api/messages",
        json={"room_id": str(uuid4()), "ciphertext": "x"},
    )
    print(f"  status={r.status_code}")
    assert r.status_code in (401, 403)
