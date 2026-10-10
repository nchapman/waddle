/**
 * Wake autonomy: a boot credential for unattended scheduled runs.
 *
 * A wake-booted machine starts locked with no keys — but the concierge
 * rebooted it precisely because work is due. The user opted into
 * background tasks (the warned delegation dialog — two-tier autonomy,
 * PLAN.md decided 2026-10-10), so the credential carries the master
 * secret, the due schedule rows, and a sealed whole-machine snapshot:
 * the boot restores the snapshot, performs a VERIFIED unlock (the
 * restored verifier makes a wrong/corrupted secret 401 before touching
 * anything), runs the due work as the user, re-snapshots, re-arms, dies.
 *
 * The escrow of record is the concierge handoff (memory-only, TTL =
 * next-due + margin); this file is the dev fallback (mounted DATA_DIR)
 * and is read only at boot. A stale credential (rotated secret) yields a
 * locked boot that re-fires the work at the next attended unlock — the
 * user unlock path is untouched — and is cleared on first user unlock.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Schedule } from "./schedules.js";

const DATA_DIR = process.env.DATA_DIR ?? "/tmp/waddle-data";
const WAKE_FILE = join(DATA_DIR, "wake-credential.json");

export interface WakeCredential {
  /** The master unlock secret — full delegation, per the warned opt-in. */
  secret: string;
  /** The due work: schedule rows to seed the ticker on a blank volume. */
  schedules?: Schedule[];
  /** Sealed whole-machine snapshot (b64, HKDF(master,"waddle/snapshot")).
   *  Absent on a degraded arm → the boot runs context-free. */
  snapshot?: string;
  /** DEV FILE ARM ONLY — never escrowed with the concierge: prod machines
   *  infer on the platform-injected TINFOIL_API_KEY (proven v0.0.40); a
   *  dev compose machine without that env needs the key to run schedules. */
  inferenceKey?: string;
}

export function autonomyEnabled(): boolean {
  return process.env.WADDLE_WAKE_AUTONOMY === "1";
}

export function armWakeCredential(cred: WakeCredential): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(WAKE_FILE, JSON.stringify(cred), { mode: 0o600 });
}

export function readWakeCredential(): WakeCredential | null {
  if (!existsSync(WAKE_FILE)) return null;
  try {
    const cred = JSON.parse(readFileSync(WAKE_FILE, "utf8")) as WakeCredential;
    return typeof cred.secret === "string" && cred.secret ? cred : null;
  } catch {
    return null;
  }
}

export function clearWakeCredential(): void {
  rmSync(WAKE_FILE, { force: true });
}
