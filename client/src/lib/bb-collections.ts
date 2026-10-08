/**
 * waddle's betterbase collections.
 *
 * The machine backup is FILE storage now (the enclave's own tar.gz — see
 * server/src/bb-backup.ts): files only, no data records. This collection
 * exists for exactly one row — the anchor record the files API requires
 * every upload to reference (`X-Record-ID`). Created once, never updated:
 * nothing here ever merges.
 */
import { collection, t } from "betterbase/db";

export const machines = collection("machines")
  .v(1, {
    /** Human label for the anchor row ("waddle machine"). */
    label: t.text(),
  })
  .build();

/** Fixed anchor record id — the files API's X-Record-ID target. */
export const MACHINES_ANCHOR_ID = "4f6a8c0e-1b2d-4e3f-9a5b-7c8d0e1f2a3b";

/** Stable collection list for the sync provider (never re-created per render). */
export const COLLECTIONS = [machines];
