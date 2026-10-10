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

/** The escrowed payload is an opaque bag — the concierge never
 *  interprets key material. Today the machine arms
 *  `{ autonomyKey, schedules[] }`: a schedule-scoped derived key (never
 *  the master secret) plus the due work itself (every deploy is a fresh
 *  volume, so the credential carries what the boot must run). */
export type HandoffCredential = Record<string, unknown>;

interface HandoffRow {
  cred: HandoffCredential;
  armedAt: number;
  expiresAt: number;
}

export interface HandoffOptions {
  /** Max wall-clock a credential may stay armed. Default 7 days (the
   * server arms with ttl_ms = next due + margin, so this is the cap). */
  ttlMs?: number;
  /** How long after a successful schedule-boot deploy a pull may release.
   * Default 3 min — the boot exists and its pull fires within seconds of
   * the app starting; a long window only invites races (SME review). */
  releaseWindowMs?: number;
  now?: () => number;
}

export interface HandoffStatus {
  armed: boolean;
  armed_ms_ago: number | null;
}

export function createHandoffStore(opts: HandoffOptions = {}) {
  const ttlMs = opts.ttlMs ?? 7 * 24 * 3600_000;
  const releaseWindowMs = opts.releaseWindowMs ?? 3 * 60_000;
  const now = opts.now ?? Date.now;
  const rows = new Map<string, HandoffRow>();
  const firedAt = new Map<string, number>();

  function arm(instance: string, cred: HandoffCredential, ttlOverrideMs?: number): { expires_in_ms: number } {
    if (!cred || typeof cred !== "object" || Object.keys(cred).length === 0) throw new Error("credential payload required");
    const ttl = typeof ttlOverrideMs === "number" ? Math.min(Math.max(ttlOverrideMs, 60_000), ttlMs) : ttlMs;
    rows.set(instance, { cred, armedAt: now(), expiresAt: now() + ttl });
    return { expires_in_ms: ttl };
  }

  /** The wake-table fire hook: the timer fired, so a schedule-boot is
   * being deployed NOW and the next machine to boot is the one this
   * fire was for. Called at FIRE time, deliberately BEFORE the deploy
   * resolves — the boot's own pull lands ~90s in and can beat the
   * deploy CLI's resolve (live-caught 01:23Z: marking after it made
   * the intended machine pull no-fire). Compensating controls for the
   * window this opens: the pool defers fills while it's open (canFill)
   * and it expires in releaseWindowMs. Idempotent within a fire;
   * cleared on release. */
  function markWakeFired(instance: string): void {
    firedAt.set(instance, now());
  }

  /** Is a release window currently open? The pool defers standby fills
   * while one is — a replacement boot racing the intended pull is the
   * standby-steal path (SME review). */
  function windowOpen(instance: string): boolean {
    const fired = firedAt.get(instance);
    return fired !== undefined && now() - fired <= releaseWindowMs;
  }

  /** One-shot release: gated on a recent fire and a live row. Returns the
   *  whole opaque payload — the concierge never looks inside it. */
  function release(instance: string): { cred: HandoffCredential; armed_ms_ago: number } | { notFound: true; reason: "no-fire" | "window" | "expired" | "absent" } {
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
    return { cred: row.cred, armed_ms_ago: now() - row.armedAt };
  }

  /** User-side revocation: wipe the row (secret rotation, "stop doing
   * things while I'm away"). Memory-only, immediate. */
  function clear(instance: string): void {
    rows.delete(instance);
    firedAt.delete(instance);
  }

  /** For /status: presence only — never key material. */
  function status(instance: string): HandoffStatus {
    const row = rows.get(instance);
    return { armed: !!row && row.expiresAt > now(), armed_ms_ago: row ? now() - row.armedAt : null };
  }

  return { arm, markWakeFired, windowOpen, release, clear, status };
}

