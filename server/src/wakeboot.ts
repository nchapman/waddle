/**
 * Wake autonomy: a boot credential for unattended scheduled runs.
 *
 * A wake-booted machine starts locked with no inference key — but the
 * concierge rebooted it precisely because work is due. When the user
 * opted in (WADDLE_WAKE_AUTONOMY=1), unlock arms a credential that the
 * next boot consumes to self-unlock: run the due work, checkpoint, die.
 *
 * Threat-model placement: the file lives in DATA_DIR — the same store the
 * log is sealed in and the shelf encrypts wholesale. Dev compose mounts it
 * as a plain volume (your own machine); prod rides the encrypted shelf.
 * A stale credential (rotated secret) fails the normal unlock path and is
 * cleared — the boot falls through to the regular locked ceremony, so it
 * can never brick the machine.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = process.env.DATA_DIR ?? "/tmp/waddle-data";
const WAKE_FILE = join(DATA_DIR, "wake-credential.json");

export interface WakeCredential {
  secret: string;
  inferenceKey?: string;
  /** Best bearer we had at arm time: bb grant token (short TTL) or the dev
   *  shared secret. Absent/stale = work still runs, death flare doesn't. */
  conciergeBearer?: string;
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
