/**
 * DM key distribution — pairwise E2EE.
 *
 * Reuses the same server endpoints as group sender keys, but with a special
 * marker: room_id = "dm:<peerId>". That tells the server "this envelope is
 * for a DM with that peer, not a real channel room" — we never persist a
 * UUID for DM "rooms", we just synthesize one from the peer pair.
 *
 * Wait — server-side schema requires room_id to be a UUID. So instead of
 * synthesizing a string, we use the peer's UUID directly as the room_id for
 * DM envelopes. That works because:
 *   - sender_id + recipient_id + room_id uniquely identifies an envelope
 *   - For a DM there are only two users, so peer.id as room_id is unique
 *   - The envelope is delivered only to the recipient, never broadcast
 */
import { api } from "./api";
import {
  ensureIdentityKey,
  ensureMyDmKey,
  exportPublicKey,
  loadDmKeyFor,
  saveDmKeyFor,
  unwrapSenderKey,
  wrapSenderKeyForRecipient,
} from "./crypto";

interface PublicKey {
  key_type: string;
  key_data: string;
}

interface Envelope {
  sender_id: string;
  encrypted_key: string;
  sender_pub: string;
  /** Server stores room_id as the peer id for DMs. */
  room_id?: string;
}

/** For DM envelopes we use min(me, peer) as the synthetic room_id so both
 * sides agree on the same value. (Server stores it as a UUID column.) */
function dmRoomId(myId: string, peerId: string): string {
  return [myId, peerId].sort()[0]; // either of the two UUIDs, consistently
}

async function fetchEcdhPublicKey(userId: string): Promise<string | null> {
  try {
    const { data } = await api.get<PublicKey[]>(`/auth/keys/${userId}`);
    return data.find((k) => k.key_type === "ecdh")?.key_data ?? null;
  } catch {
    return null;
  }
}

/**
 * Wrap my DM key for the peer and upload it. Idempotent server-side
 * (upserts by (room, sender, recipient)), so calling on every chat open is
 * safe and ensures the peer can decrypt new messages after first contact.
 */
export async function distributeMyDmKey(
  peerId: string,
  myId: string
): Promise<void> {
  const dmKey = await ensureMyDmKey(peerId, myId);
  const identity = await ensureIdentityKey();
  const myPub = await exportPublicKey(identity.publicKey);

  const peerPub = await fetchEcdhPublicKey(peerId);
  if (!peerPub) return; // peer never logged in / no key uploaded yet

  const encrypted = await wrapSenderKeyForRecipient(
    identity.privateKey,
    peerPub,
    dmKey
  );

  await api.post("/messages/sender-keys", {
    envelopes: [
      {
        room_id: dmRoomId(myId, peerId),
        recipient_id: peerId,
        key_id: `dm:${myId}:${peerId}`,
        encrypted_key: encrypted,
        sender_pub: myPub,
      },
    ],
  });
}

/** Pull the peer's wrapped key and unwrap it for me. */
export async function fetchAndStorePeerDmKey(
  peerId: string,
  myId: string
): Promise<void> {
  const identity = await ensureIdentityKey();
  const { data: envelopes } = await api.get<Envelope[]>(
    `/messages/sender-keys/${dmRoomId(myId, peerId)}`
  );
  for (const env of envelopes) {
    if (env.sender_id !== peerId) continue; // only the peer's envelope
    if (await loadDmKeyFor(peerId, peerId)) continue; // already have it
    try {
      const key = await unwrapSenderKey(
        identity.privateKey,
        env.sender_pub,
        env.encrypted_key
      );
      await saveDmKeyFor(peerId, peerId, key);
    } catch (e) {
      console.warn("Failed to unwrap DM key from", peerId, e);
    }
  }
}

/** Run both directions on chat open. Safe to call multiple times. */
export async function setupDmKeys(peerId: string, myId: string): Promise<void> {
  await ensureMyDmKey(peerId, myId);
  await distributeMyDmKey(peerId, myId);
  await fetchAndStorePeerDmKey(peerId, myId);
}
