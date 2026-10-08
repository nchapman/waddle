/**
 * waddle's betterbase collections.
 *
 * The durable conversation snapshot is a single-record collection: the
 * existing AEAD envelope (HKDF(unlock secret, "backup") — see lib/backup.ts)
 * rides as an opaque text blob. betterbase's E2EE already hides it from the
 * service; our envelope means even another client of the same account reads
 * nothing without the unlock secret. One record, id "current", upserted per
 * checkpoint — CRDT last-write on a doc, no per-event sync needed.
 */
import { collection, t } from "betterbase/db";

export const snapshots = collection("snapshots")
  .v(1, {
    /** JSON envelope: { n, ct, iv } — ciphertext + nonce, base64. */
    blob: t.text(),
    /** Monotonic generation; higher wins on merge decisions. */
    gen: t.number(),
    /** "updatedAt" is reserved — gen doubles as the timestamp-ordered version. */
    savedAt: t.number(),
  })
  .build();

/**
 * The snapshot record id: a fixed UUID (the sync storage layer refuses
 * non-UUID ids server-side) pinned so every checkpoint upserts one row.
 * (Legacy: newer checkpoints append fresh UUIDs instead — see
 * putSnapshot — this id only marks the pre-append rows.)
 */
export const SNAPSHOT_ID = "3d444725-e6eb-44c8-b2ce-e86344d5d28f";

/** How many recent snapshot records to keep when pruning. */
export const SNAPSHOT_KEEP = 3;

/** Stable collection list for the sync provider (must not be re-created per render). */
export const COLLECTIONS = [snapshots];
