/**
 * The delegation switch, client side (two-tier autonomy, PLAN.md).
 *
 * Background tasks off (default) = tier 0: the enclave arms nothing at
 * sleep, the concierge holds zero secrets. On = tier 1: the user has
 * accepted the warning and delegates full capabilities — the escrow
 * carries the master secret, schedules, and a sealed whole-machine
 * snapshot so scheduled boots restore state and act as the user.
 *
 * The client is the source of truth while the user is present: the pref
 * rides every unlock; the server copy (in the snapshot) serves unattended
 * boots and new devices.
 */

const PREF_KEY = "waddle.background";
const ACCEPTED_KEY = "waddle.backgroundAccepted";

/** Tri-state: null = never chosen on this device (a fresh browser). */
export function getBackgroundPref(): boolean | null {
  const v = localStorage.getItem(PREF_KEY);
  return v === "1" ? true : v === "0" ? false : null;
}

export function setBackgroundPref(on: boolean): void {
  localStorage.setItem(PREF_KEY, on ? "1" : "0");
  if (!on) localStorage.removeItem(ACCEPTED_KEY);
}

/** The warning is shown once per device — acceptance is sticky while on. */
export function hasAcceptedWarning(): boolean {
  return localStorage.getItem(ACCEPTED_KEY) === "1";
}

export function acceptWarning(): void {
  localStorage.setItem(ACCEPTED_KEY, "1");
  localStorage.setItem(PREF_KEY, "1");
}
