/**
 * Concierge calls: /boot discovery, readiness polls, health polls. Pure
 * async functions — App supplies the auth token thunk (the betterbase
 * session hydrates async; a first-render closure would pin a dead null
 * forever). Auth prefers the betterbase session token (the TEE'd
 * concierge verifies it); dev falls back to the shared-secret env.
 */
import { CONCIERGE_TOKEN, CONCIERGE_URL, ZONE } from "./config";

export type ConciergeAuth = () => Promise<string | null>;

/** Headers for a concierge verb: the bb JWT when the session has one,
 *  the dev token in DEV parity, nothing in live builds without a
 *  session (a live shared secret must never ride the bundle). */
async function authHeaders(auth: ConciergeAuth): Promise<Record<string, string>> {
  const token = (await auth().catch(() => null)) ?? CONCIERGE_TOKEN;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function pollUntilHealthy(
  url: string,
  attempts = 60,
  onTick?: (attempt: number) => void,
  intervalMs = 2_000,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    await new Promise((r) => setTimeout(r, intervalMs));
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(4000) });
      if (res.ok) return true;
    } catch {
      /* still booting */
    }
    onTick?.(i + 1);
  }
  return false;
}

export async function bootInstance(
  auth: ConciergeAuth,
  timeoutMs = 300_000,
  zone = ZONE,
  fresh = false,
): Promise<{ ok: boolean; url?: string; instance?: string; waking?: boolean; detail?: string }> {
  const z = zone.replace(/^\.+/, "");
  const headers = await authHeaders(auth);
  if (!headers.Authorization) {
    return { ok: false, detail: "no betterbase session — connect your store to wake the enclave" };
  }
  try {
    const res = await fetch(`${CONCIERGE_URL}/boot`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ fresh }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, detail: `concierge refused (${res.status}) ${body.slice(0, 120)}` };
    }
    const m = (await res.json().catch(() => null)) as { url?: string; instance?: string; status?: string; detail?: string } | null;
    let host = "";
    try {
      host = m?.url ? new URL(m.url).hostname : "";
    } catch {
      /* malformed URL — refused below */
    }
    if (!m?.url || !host || !z || !(host === z || host.endsWith(`.${z}`))) {
      return { ok: false, detail: `concierge returned an unusable machine URL${m?.url ? ` (${m.url})` : ""} — refusing` };
    }
    return { ok: true, url: m.url, instance: m.instance, waking: m.status !== "running", detail: m.detail };
  } catch (e) {
    const stalled = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    return {
      ok: false,
      detail: stalled
        ? `concierge stalled — boot gave up after ${Math.round(timeoutMs / 1000)}s (deploy still running?)`
        : "concierge unreachable — is it running?",
    };
  }
}

/** The full wake gate, concierge-first — machine-second. A
 *  "running" /boot answer is a platform table row, not a DNS fact: a
 *  stale row, a torn-down redeploy, or resolver lag can all leave the
 *  name dark while the table says Running. /boot/ready re-verifies
 *  status + DNS on the concierge (cache-free c-ares) and only its 200
 *  clears the client to touch the machine's name — an early query
 *  would teach the browser's resolver chain a 30-minute NXDOMAIN for
 *  a machine that's about to be fine. The health leg runs client-side
 *  after the gate (the concierge's egress allowlist cannot reach
 *  instance hosts — architectural, see AGENTS.md). */
export async function awaitMachineReady(
  auth: ConciergeAuth,
  booted: { url: string; instance?: string; waking?: boolean },
  onNote?: (note: string) => void,
  opts: { readyAttempts?: number; healthAttempts?: number; intervalMs?: number } = {},
): Promise<{ ready: boolean; healthy: boolean }> {
  const intervalMs = opts.intervalMs ?? 2_000;
  let i = 0;
  const ready = booted.instance
    ? await pollBootReady(auth, booted.instance, opts.readyAttempts ?? 90, () => onNote?.(`waiting for the enclave… (${++i})`), intervalMs)
    : !booted.waking; // no instance to gate on: trust the boot answer as before
  if (!ready) return { ready: false, healthy: false };
  let j = 0;
  const healthy = await pollUntilHealthy(booted.url, opts.healthAttempts ?? 30, () => onNote?.(`waking the agent… (${++j})`), intervalMs);
  return { ready: true, healthy };
}

/** Readiness poll — against the CONCIERGE, never the booting machine.
 *  The machine's DNS record doesn't exist until seconds after it goes
 *  Running; polling it early teaches every cache in the browser's
 *  resolver chain a 30-minute NXDOMAIN for a machine that's about to be
 *  fine (caught live, 2026-10-11). The concierge gates on Running + DNS
 *  (cache-free c-ares) and says when the coast is clear. */
export async function pollBootReady(
  auth: ConciergeAuth,
  instance: string,
  attempts = 90,
  onTick?: (attempt: number) => void,
  intervalMs = 2_000,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${CONCIERGE_URL}/boot/ready?instance=${encodeURIComponent(instance)}`, {
        headers: await authHeaders(auth),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) return true;
    } catch {
      /* concierge hiccup — retry */
    }
    await new Promise((r) => setTimeout(r, intervalMs));
    onTick?.(i + 1);
  }
  return false;
}
