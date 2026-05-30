/**
 * Sender Keys orchestration — group E2EE for a channel room.
 *
 * On entering a room:
 *   1. ensureMySenderKey   — make sure I have my own AES sender key.
 *   2. distributeMySenderKey — wrap it for every other channel member
 *      (pairwise ECDH) and upload the envelopes to the server.
 *   3. fetchAndStoreSenderKeys — pull envelopes addressed to me, unwrap,
 *      store under (room, senderId).
 *
 * After this, decryptFromSender(roomId, senderId, ct) works for every
 * member who has distributed their key to me.
 *
 * Whenever a new member joins or a new key is published, the gateway
 * broadcasts `senderkey.new` on the recipient's user channel — clients
 * react by calling fetchAndStoreSenderKeys again.
 */
import { api } from "./api";
import {
  ensureIdentityKey,
  ensureMySenderKey,
  exportPublicKey,
  loadSenderKeyFor,
  saveSenderKeyFor,
  unwrapSenderKey,
  wrapSenderKeyForRecipient,
} from "./crypto";

interface Member {
  user_id: string;
}

interface PublicKey {
  key_type: string;
  key_data: string;
}

function myKeyId(roomId: string, myId: string): string {
  return `${roomId}:${myId}`;
}

/** Fetch a user's ECDH public key (SPKI base64), or null if absent. */
async function fetchEcdhPublicKey(userId: string): Promise<string | null> {
  try {
    const { data } = await api.get<PublicKey[]>(`/auth/keys/${userId}`);
    const ecdh = data.find((k) => k.key_type === "ecdh");
    return ecdh?.key_data ?? null;
  } catch {
    return null;
  }
}

/**
 * Wrap my sender key for every other channel member and upload envelopes.
 * Skips recipients with no published ECDH key (they haven't logged in
 * since key setup) — they'll get the key the next time we distribute.
 */
export async function distributeMySenderKey(
  roomId: string,
  channelId: string,
  myId: string
): Promise<number> {
  const senderKey = await ensureMySenderKey(roomId, myId);
  const identity = await ensureIdentityKey();
  const myPub = await exportPublicKey(identity.publicKey);

  const { data: members } = await api.get<Member[]>(
    `/channels/${channelId}/members`
  );
  const others = members.map((m) => m.user_id).filter((id) => id !== myId);

  const envelopes: Array<{
    room_id: string;
    recipient_id: string;
    key_id: string;
    encrypted_key: string;
    sender_pub: string;
  }> = [];

  for (const recipientId of others) {
    const recipientPub = await fetchEcdhPublicKey(recipientId);
    if (!recipientPub) continue;
    try {
      const encrypted = await wrapSenderKeyForRecipient(
        identity.privateKey,
        recipientPub,
        senderKey
      );
      envelopes.push({
        room_id: roomId,
        recipient_id: recipientId,
        key_id: myKeyId(roomId, myId),
        encrypted_key: encrypted,
        sender_pub: myPub,
      });
    } catch (e) {
      console.warn(`Failed to wrap key for ${recipientId}:`, e);
    }
  }

  if (envelopes.length > 0) {
    await api.post("/messages/sender-keys", { envelopes });
  }
  return envelopes.length;
}

/**
 * Pull all envelopes addressed to me in this room, unwrap each, and store
 * the corresponding sender's key locally so subsequent messages decrypt.
 */
export async function fetchAndStoreSenderKeys(roomId: string): Promise<number> {
  const identity = await ensureIdentityKey();
  const { data: envelopes } = await api.get<
    Array<{ sender_id: string; encrypted_key: string; sender_pub: string }>
  >(`/messages/sender-keys/${roomId}`);

  let stored = 0;
  for (const env of envelopes) {
    // Skip if we already unwrapped this sender's key (idempotent).
    const existing = await loadSenderKeyFor(roomId, env.sender_id);
    if (existing) continue;
    try {
      const key = await unwrapSenderKey(
        identity.privateKey,
        env.sender_pub,
        env.encrypted_key
      );
      await saveSenderKeyFor(roomId, env.sender_id, key);
      stored += 1;
    } catch (e) {
      console.warn(`Failed to unwrap key from ${env.sender_id}:`, e);
    }
  }
  return stored;
}

/** Full setup when entering a room. Safe to call multiple times. */
export async function setupRoomKeys(
  roomId: string,
  channelId: string,
  myId: string
): Promise<void> {
  await ensureMySenderKey(roomId, myId);
  // Distribute first so other clients can already decrypt new messages from
  // me. Then pull others' keys so I can decrypt theirs. Order is not strict
  // because `senderkey.new` events will trigger another fetch if needed.
  await distributeMySenderKey(roomId, channelId, myId);
  await fetchAndStoreSenderKeys(roomId);
}
