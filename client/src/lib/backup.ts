/**
 * Device snapshot: the event log, AEAD-sealed under HKDF(secret, "backup"),
 * kept on this device. The enclave's scratch is wiped on every sleep (the
 * platform's ephemeral filesystem), so this is First Light's restore source
* on wake. The betterbase store replaces this device as the transport later
 * — same ciphertext, same keys, different shelf (the design keeps every
 * enrolled device a partial backup; this is that sentence, running).
 */
import type { ChatMessage } from "../App";

const BACKUP_KEY = "waddle.backup";

interface SealedSnapshot {
  v: 1;
  iv: string;
  ct: string;
  gen: number;
  at: string;
}

function b64(bytes: Uint8Array): string {
  // Chunked: spreading a multi-MB ciphertext into one call overflows the
  // stack — this broke every push once the pi transcript (jsonl) rode the
  // snapshot. 32k args per slice is safely under any engine's limit.
  let out = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(out);
}
function unb64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

async function backupKey(secretB64: string): Promise<CryptoKey> {
  const secret = unb64(secretB64);
  const root = await crypto.subtle.importKey("raw", secret as unknown as BufferSource, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode("waddle/backup") },
    root,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export type { SealedSnapshot };

/** What travels inside the envelope: the UI rows plus (v2) the pi
 *  session transcript — the agent's native-resume payload. Old envelopes
 *  seal a bare array; openSnapshot normalizes both. */
export interface SnapshotPayload {
  rows: ChatMessage[];
  jsonl?: string | null;
}

/** Encrypt under HKDF(secret, "waddle/backup") — the one envelope both the
 *  device snapshot and the betterbase store use. */
export async function sealSnapshot(
  secret: string,
  messages: ChatMessage[],
  prevGen = 0,
  jsonl?: string | null,
): Promise<SealedSnapshot> {
  const key = await backupKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const payload: SnapshotPayload = { rows: messages, ...(jsonl ? { jsonl } : {}) };
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return {
    v: 1,
    iv: b64(iv),
    ct: b64(new Uint8Array(ct)),
    gen: prevGen + 1,
    at: new Date().toISOString(),
  };
}

export async function openSnapshot(
  secret: string,
  sealed: SealedSnapshot,
): Promise<SnapshotPayload | null> {
  try {
    const key = await backupKey(secret);
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(sealed.iv) as unknown as BufferSource },
      key,
      unb64(sealed.ct) as unknown as BufferSource,
    );
    const parsed: unknown = JSON.parse(new TextDecoder().decode(pt));
    if (Array.isArray(parsed)) return { rows: parsed as ChatMessage[] }; // v1 envelope
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as SnapshotPayload).rows)) {
      return parsed as SnapshotPayload;
    }
    return null;
  } catch {
    return null; // wrong secret or corrupt — treat as absent
  }
}

export async function saveSnapshot(secret: string, messages: ChatMessage[], jsonl?: string | null): Promise<void> {
  const prev = loadSealed();
  const snap = await sealSnapshot(secret, messages, prev?.gen ?? 0, jsonl);
  localStorage.setItem(BACKUP_KEY, JSON.stringify(snap));
}

function loadSealed(): SealedSnapshot | null {
  try {
    const raw = localStorage.getItem(BACKUP_KEY);
    return raw ? (JSON.parse(raw) as SealedSnapshot) : null;
  } catch {
    return null;
  }
}

export async function loadSnapshot(secret: string): Promise<SnapshotPayload | null> {
  const sealed = loadSealed();
  if (!sealed) return null;
  return openSnapshot(secret, sealed);
}
