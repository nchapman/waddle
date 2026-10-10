/**
 * The postbox — memory-only return mail for unattended runs.
 *
 * An autonomous machine (schedule-boot, subkey-unlocked) cannot push its
 * transcript to the user's shelf: the shelf path needs a betterbase grant
 * that only a client unlock supplies. So at re-sleep it drops a SEALED
 * blob here — the machine that finds it is the one holding the key
 * (any unlock derives it: master → autonomy subkey → postbox key). The
 * concierge stores ciphertext only; AEAD integrity binds instance + tag.
 *
 * Delivery is pull-and-clear at the next unlock. Nothing persists: a
 * concierge restart loses undelivered mail — the honest degradation is
 * "the schedule's output waited and died," never corruption. (The
 * schedule itself re-fires from the shelf in that case — eventual
 * consistency, the pre-postbox behavior.)
 */

export interface PostboxOptions {
  /** How long undelivered mail may sit. Default 7 days. */
  ttlMs?: number;
  now?: () => number;
}

interface PostboxRow {
  blob: string;
  postedAt: number;
  expiresAt: number;
}

export function createPostboxStore(opts: PostboxOptions = {}) {
  const ttlMs = opts.ttlMs ?? 7 * 24 * 3600_000;
  const now = opts.now ?? Date.now;
  const rows = new Map<string, PostboxRow>();

  /** Store (replace) an instance's mail. The blob is opaque ciphertext. */
  function post(instance: string, blob: string): { expires_in_ms: number } {
    if (typeof blob !== "string" || !blob) throw new Error("blob required");
    rows.set(instance, { blob, postedAt: now(), expiresAt: now() + ttlMs });
    return { expires_in_ms: ttlMs };
  }

  /** Pull-and-clear: one delivery, then the mailbox is empty. Expired
   *  mail is dropped (returns null) — a stale blob must never surface. */
  function pull(instance: string): string | null {
    const row = rows.get(instance);
    if (!row) return null;
    rows.delete(instance);
    if (row.expiresAt <= now()) return null;
    return row.blob;
  }

  /** User-side revocation (rarely needed: mail is already sealed to the
   *  user's own key). Also clears any open window bookkeeping upstream. */
  function clear(instance: string): void {
    rows.delete(instance);
  }

  /** For /status: presence only — never the blob. */
  function status(instance: string): { held: boolean; posted_ms_ago: number | null } {
    const row = rows.get(instance);
    return { held: !!row && row.expiresAt > now(), posted_ms_ago: row ? now() - row.postedAt : null };
  }

  return { post, pull, clear, status };
}

