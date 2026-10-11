/**
 * The Snapshot — whole-machine state riding the wake escrow.
 *
 * Two-tier autonomy (PLAN.md, decided 2026-10-10): with background tasks
 * on, the user delegates full capabilities to the enclave, and the escrow
 * carries {master secret, schedules, sealed snapshot} in concierge memory.
 * The snapshot is the same archive the shelf uses (~64 KiB zstd tar of
 * DATA_DIR), sealed under HKDF(master, "waddle/snapshot") with the
 * instance-free AAD. It is hygiene, not a boundary: the escrow holds
 * the key too, by design — the warning dialog is the boundary. Sealing
 * protects the blob if it ever leaks without the key (logs, side stores).
 */
import { derive, seal, open } from "./keys.js";

/** AAD v2: instance-free — a wake boot opens its snapshot before the
 *  pull/handshake can teach it its name (see postbox.ts). */
const AAD = "waddle-snapshot-v2";

export function sealSnapshot(secretB64: string, body: Buffer): string {
  const key = derive(Buffer.from(secretB64, "base64"), "waddle/snapshot");
  return seal(key, body, AAD).toString("base64");
}

/** Throws on wrong key / tampered blob — callers degrade to a
 *  context-free boot, never crash the schedule. */
export function openSnapshot(secretB64: string, blobB64: string): Buffer {
  const key = derive(Buffer.from(secretB64, "base64"), "waddle/snapshot");
  return open(key, Buffer.from(blobB64, "base64"), AAD);
}
