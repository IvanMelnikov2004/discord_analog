/**
 * Web Crypto API utilities for E2EE.
 *
 * Keys live in IndexedDB as non-extractable CryptoKey objects.
 * - ECDH P-256: key agreement (each user has one keypair)
 * - ECDSA P-256: signing identity (optional for MVP, kept for completeness)
 * - AES-256-GCM: message encryption (per-room sender keys)
 *
 * For MVP we focus on group sender-key generation, marshalling public keys,
 * and AES-GCM encrypt/decrypt of message bodies.
 *
 * IMPORTANT: window.crypto.subtle is ONLY available in a "secure context"
 * (https:// or http://localhost). Over plain http:// on a remote IP it is
 * undefined and every call here throws. assertCryptoAvailable() gives a clear
 * error instead of a cryptic "cannot read properties of undefined".
 */

/** Returns true if Web Crypto is usable (secure context). */
export function isCryptoAvailable(): boolean {
  return (
    typeof window !== "undefined" &&
    !!window.isSecureContext &&
    !!window.crypto &&
    !!window.crypto.subtle
  );
}

export function assertCryptoAvailable(): void {
  if (!isCryptoAvailable()) {
    throw new Error(
      "Шифрование недоступно: откройте приложение по HTTPS (или http://localhost). " +
        "Web Crypto API не работает на незащищённом соединении."
    );
  }
}

const DB_NAME = "messenger-crypto";
const DB_VERSION = 1;
const KEYS_STORE = "keys";

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(KEYS_STORE)) {
        db.createObjectStore(KEYS_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet<T = unknown>(key: string): Promise<T | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KEYS_STORE, "readonly");
    const req = tx.objectStore(KEYS_STORE).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(key: string, value: unknown): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KEYS_STORE, "readwrite");
    tx.objectStore(KEYS_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------- base64 helpers ----------

export function bufToB64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.byteLength; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function b64ToBuf(b64: string): ArrayBuffer {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes.buffer;
}

// ---------- ECDH P-256 (identity key) ----------

export async function ensureIdentityKey(): Promise<CryptoKeyPair> {
  assertCryptoAvailable();
  const existing = await idbGet<CryptoKeyPair>("identity-ecdh");
  if (existing) return existing;

  const kp = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false, // non-extractable private key
    ["deriveKey", "deriveBits"]
  );
  await idbPut("identity-ecdh", kp);
  return kp;
}

export async function exportPublicKey(key: CryptoKey): Promise<string> {
  const spki = await crypto.subtle.exportKey("spki", key);
  return bufToB64(spki);
}

export async function importEcdhPublicKey(b64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "spki",
    b64ToBuf(b64),
    { name: "ECDH", namedCurve: "P-256" },
    true,
    []
  );
}

// ---------- AES-256-GCM Sender Keys (E2EE group chat) ----------
//
// Model (Signal-style "sender keys"):
//   - Each user has ONE AES-256 sender key per room they participate in.
//   - They encrypt every outgoing message with their own sender key.
//   - They distribute that sender key to every other room member, wrapping
//     it with a pairwise ECDH shared secret (so only the recipient can
//     unwrap it). The server only ever sees ciphertext envelopes.
//   - The keystore key in IndexedDB is "sender-key:<room>:<userId>".
//     The user's OWN key is stored under their own userId; received keys
//     are stored under their respective sender's userId.
//   - To decrypt, the client looks up the key by the message's sender_id.

export async function generateSenderKey(): Promise<CryptoKey> {
  assertCryptoAvailable();
  // `extractable=true` because we need to export the raw bytes when wrapping
  // for recipients. Private ECDH keys remain non-extractable; only the
  // symmetric room key is exportable, and only the wrapped form ever leaves
  // this device.
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
}

function senderKeyId(roomId: string, userId: string): string {
  return `sender-key:${roomId}:${userId}`;
}

export async function saveSenderKeyFor(
  roomId: string,
  userId: string,
  key: CryptoKey
): Promise<void> {
  await idbPut(senderKeyId(roomId, userId), key);
}

export async function loadSenderKeyFor(
  roomId: string,
  userId: string
): Promise<CryptoKey | undefined> {
  return idbGet<CryptoKey>(senderKeyId(roomId, userId));
}

/** Ensure the current user has their OWN sender key for the room. */
export async function ensureMySenderKey(
  roomId: string,
  myId: string
): Promise<CryptoKey> {
  let key = await loadSenderKeyFor(roomId, myId);
  if (!key) {
    key = await generateSenderKey();
    await saveSenderKeyFor(roomId, myId, key);
  }
  return key;
}

/** Encrypt a plaintext message with MY sender key. */
export async function encryptWithMyKey(
  roomId: string,
  myId: string,
  plaintext: string
): Promise<string> {
  const key = await ensureMySenderKey(roomId, myId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  const combined = new Uint8Array(iv.byteLength + ct.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ct), iv.byteLength);
  return bufToB64(combined.buffer);
}

/** Decrypt a message using the SENDER's key (looked up by senderId). */
export async function decryptFromSender(
  roomId: string,
  senderId: string,
  b64: string
): Promise<string> {
  const key = await loadSenderKeyFor(roomId, senderId);
  if (!key) throw new Error("No sender key for this sender yet");
  const combined = new Uint8Array(b64ToBuf(b64));
  const iv = combined.slice(0, 12);
  const ct = combined.slice(12);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(pt);
}

// ---------- ECDH key wrapping ----------

/** Derive a 256-bit AES-GCM key from my private + their public ECDH. */
async function deriveSharedKey(
  myPrivate: CryptoKey,
  theirPublic: CryptoKey
): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    { name: "ECDH", public: theirPublic },
    myPrivate,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/**
 * Wrap (encrypt) my sender key for one recipient. The recipient's ECDH
 * public key (b64 SPKI) is fetched from the server and used to derive the
 * shared secret. Returns base64(nonce + ciphertext).
 */
export async function wrapSenderKeyForRecipient(
  myPrivate: CryptoKey,
  recipientPubB64: string,
  senderKey: CryptoKey
): Promise<string> {
  const recipientPub = await importEcdhPublicKey(recipientPubB64);
  const shared = await deriveSharedKey(myPrivate, recipientPub);
  const raw = await crypto.subtle.exportKey("raw", senderKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, shared, raw);
  const combined = new Uint8Array(iv.byteLength + ct.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ct), iv.byteLength);
  return bufToB64(combined.buffer);
}

/**
 * Unwrap (decrypt) a sender-key envelope addressed to me. Imports the
 * decrypted raw bytes into an AES-GCM CryptoKey so the rest of the app can
 * use it.
 */
export async function unwrapSenderKey(
  myPrivate: CryptoKey,
  senderPubB64: string,
  encryptedKeyB64: string
): Promise<CryptoKey> {
  const senderPub = await importEcdhPublicKey(senderPubB64);
  const shared = await deriveSharedKey(myPrivate, senderPub);
  const combined = new Uint8Array(b64ToBuf(encryptedKeyB64));
  const iv = combined.slice(0, 12);
  const ct = combined.slice(12);
  const raw = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, shared, ct);
  return crypto.subtle.importKey(
    "raw",
    raw,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
}

