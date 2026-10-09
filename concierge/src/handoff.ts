/**
 * The wake-credential handoff — the concierge's memory-only escrow for
 * unattended scheduled runs.
 *
 * Contract (the autonomy path depends on every clause):
 *  - arm() stores the credential in MEMORY, keyed by instance, with a TTL
 *  - a credential is released ONLY after markWakeFired() for that
 *    instance — pool standbys and user-wakes boot locked; only a
 *    schedule-boot gets the key. Release is one-shot per fire.
 *  - release() after the window (or past expiry) reports not-found, and
 *    the boot falls through to the normal locked ceremony
 *  - nothing persists: a concierge restart silently degrades autonomy to
 *    "waits for the user's next unlock" — the same state as today
 *
 * Threat-model placement: the concierge TEE holds the user's secret in
 * memory between sessions, releasing it only to machines it booted for a
 * fired wake row. Nothing at rest, anywhere, ever.
 */

export interface HandoffCredential {
  secret: string;
  inferenceKey?: string;
  /** Best bearer at arm time (bb JWT or shared secret) — best-effort for
   * the wake-boot's handshake; stale tokens just fall back. */
  conciergeBearer?: string;
}

interface HandoffRow extends HandoffCredential {
  armedAt: number;
  expiresAt: number;
}

export interface HandoffOptions {
  /** Max wall-clock a credential may stay armed. Default 7 days. */
  ttlMs?: number;
  /** How long after a wake fire a pull may release. Default 15 min —
   * the boot takes ~90s, the due work minutes; the pull is seconds in. */
  releaseWindowMs?: number;
  now?: () => number;
}

export interface HandoffStatus {
  armed: boolean;
  armed_ms_ago: number | null;
}

export function createHandoffStore(opts: HandoffOptions = {}) {
  const ttlMs = opts.ttlMs ?? 7 * 24 * 3600_000;
  const releaseWindowMs = opts.releaseWindowMs ?? 15 * 60_000;
  const now = opts.now ?? Date.now;
  const rows = new Map<string, HandoffRow>();
  const firedAt = new Map<string, number>();

  function arm(instance: string, cred: HandoffCredential, ttlOverrideMs?: number): { expires_in_ms: number } {
    const ttl = typeof ttlOverrideMs === "number" ? Math.min(Math.max(ttlOverrideMs, 60_000), ttlMs) : ttlMs;
    rows.set(instance, { ...cred, armedAt: now(), expiresAt: now() + ttl });
    return { expires_in_ms: ttl };
  }

  /** The wake-table fire hook: records that a schedule-boot is why the
   * next machine exists. Idempotent within a fire; cleared on release. */
  function markWakeFired(instance: string): void {
    firedAt.set(instance, now());
  }

  /** One-shot release: gated on a recent fire and a live row. */
  function release(instance: string): (HandoffCredential & { armed_ms_ago: number }) | { notFound: true; reason: "no-fire" | "window" | "expired" | "absent" } {
    const fired = firedAt.get(instance);
    if (fired === undefined || now() - fired > releaseWindowMs) {
      const row0 = rows.get(instance);
      if (row0 && row0.expiresAt <= now()) rows.delete(instance);
      return { notFound: true, reason: fired === undefined ? "no-fire" : "window" };
    }
    const row = rows.get(instance);
    if (!row) return { notFound: true, reason: "absent" };
    if (row.expiresAt <= now()) {
      rows.delete(instance);
      return { notFound: true, reason: "expired" };
    }
    firedAt.delete(instance); // one-shot per fire: first pull wins
    return { secret: row.secret, inferenceKey: row.inferenceKey, conciergeBearer: row.conciergeBearer, armed_ms_ago: now() - row.armedAt };
  }

  /** For /status: presence only — never key material. */
  function status(instance: string): HandoffStatus {
    const row = rows.get(instance);
    return { armed: !!row && row.expiresAt > now(), armed_ms_ago: row ? now() - row.armedAt : null };
  }

  return { arm, markWakeFired, release, status };
}

export type HandoffStore = ReturnType<typeof createHandoffStore>;
