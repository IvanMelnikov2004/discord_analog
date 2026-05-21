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

// ---------- AES-256-GCM (sender keys) ----------

export async function generateSenderKey(): Promise<CryptoKey> {
  assertCryptoAvailable();
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

export async function saveSenderKey(roomId: string, key: CryptoKey): Promise<void> {
  await idbPut(`sender-key:${roomId}`, key);
}

export async function loadSenderKey(roomId: string): Promise<CryptoKey | undefined> {
  return idbGet<CryptoKey>(`sender-key:${roomId}`);
}

export async function encryptForRoom(roomId: string, plaintext: string): Promise<string> {
  const key = await loadSenderKey(roomId);
  if (!key) throw new Error("No sender key for this room");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  // Concatenate iv (12) + ciphertext, base64 it.
  const combined = new Uint8Array(iv.byteLength + ct.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ct), iv.byteLength);
  return bufToB64(combined.buffer);
}

export async function decryptForRoom(roomId: string, b64: string): Promise<string> {
  const key = await loadSenderKey(roomId);
  if (!key) throw new Error("No sender key for this room");
  const combined = new Uint8Array(b64ToBuf(b64));
  const iv = combined.slice(0, 12);
  const ct = combined.slice(12);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(pt);
}
