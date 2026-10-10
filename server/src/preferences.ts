/**
 * User preferences (two-tier autonomy). The background-tasks flag is the
 * delegation switch: off = the sleep gate arms nothing, the concierge
 * holds zero secrets (tier 0, maximum privacy); on = full delegation,
 * the warned opt-in (tier 1). Small plaintext file in DATA_DIR — it is
 * not secret, and it travels inside the snapshot so it survives boots.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = process.env.DATA_DIR ?? "/tmp/waddle-data";
const FILE = join(DATA_DIR, "preferences.json");

export interface Preferences {
  /** Background tasks = full delegation to the enclave (warned opt-in). */
  background: boolean;
  /** When the user accepted the delegation warning (audit trail). */
  backgroundAcceptedAt?: string;
}

let cache: Preferences | null = null;

export function getPreferences(): Preferences {
  if (cache) return cache;
  try {
    cache = existsSync(FILE) ? (JSON.parse(readFileSync(FILE, "utf8")) as Preferences) : { background: false };
  } catch {
    cache = { background: false };
  }
  if (typeof cache.background !== "boolean") cache = { background: false };
  return cache;
}

export function setPreferences(next: Partial<Preferences>): Preferences {
  const prev = getPreferences();
  const merged: Preferences = { ...prev, ...next };
  // The audit stamp is the module's job, not the caller's: any transition
  // into tier 1 (background on) records when the warning was accepted.
  if (merged.background && !prev.background && !merged.backgroundAcceptedAt) {
    merged.backgroundAcceptedAt = new Date().toISOString();
  }
  if (!merged.background) delete merged.backgroundAcceptedAt;
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(merged), { mode: 0o600 });
  cache = merged;
  return merged;
}

/** The delegation switch — gates schedule creation and escrow arming. */
export function backgroundTasksEnabled(): boolean {
  return getPreferences().background;
}
