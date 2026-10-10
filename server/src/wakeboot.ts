/**
 * Wake autonomy: a boot credential for unattended scheduled runs.
 *
 * A wake-booted machine starts locked with no keys — but the concierge
 * rebooted it precisely because work is due. When the user opted in
 * (WADDLE_WAKE_AUTONOMY=1), unlock arms a credential that the next boot
 * consumes to self-unlock: run the due work, post the results, die.
 *
 * The credential is SCHEDULE-SCOPED: an autonomy subkey derived from the
 * master (never the master itself), plus the due schedule rows — every
 * deploy is a fresh volume, so the work travels with the key. The escrow
 * of record is the concierge handoff (memory-only); this file is the dev
 * fallback (mounted DATA_DIR) and is read only at boot. A stale
 * credential (rotated secret) just yields a useless subkey session — the
 * user unlock path is untouched — and is cleared on first user unlock.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Schedule } from "./schedules.js";

const DATA_DIR = process.env.DATA_DIR ?? "/tmp/waddle-data";
const WAKE_FILE = join(DATA_DIR, "wake-credential.json");

export interface WakeCredential {
  /** HKDF(master,"autonomy") — unlocks the machine for scheduled work only. */
  autonomyKey: string;
  /** The due work: schedule rows to seed the ticker on a blank volume. */
  schedules?: Schedule[];
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
    return typeof cred.autonomyKey === "string" && cred.autonomyKey ? cred : null;
  } catch {
    return null;
  }
}

export function clearWakeCredential(): void {
  rmSync(WAKE_FILE, { force: true });
}
