/**
 * Concierge calls: wake / standby-assign / health-poll. Pure async
 * functions — App supplies the auth token thunk (the betterbase session
 * hydrates async; a first-render closure would pin a dead null forever).
 * Auth prefers the betterbase session token (the TEE'd concierge verifies
 * it); dev falls back to the shared-secret env.
 */
import { CONCIERGE_TOKEN, CONCIERGE_URL } from "./config";

export type ConciergeAuth = () => Promise<string | null>;

/** Headers for a concierge verb: the bb JWT when the session has one,
 *  the dev token in DEV parity, nothing in live builds without a
 *  session (a live shared secret must never ride the bundle). */
async function authHeaders(auth: ConciergeAuth): Promise<Record<string, string>> {
  const token = (await auth().catch(() => null)) ?? CONCIERGE_TOKEN;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Wake the primary instance through the concierge. The request is
 *  synchronous by design: the concierge runs the deploy (75–95s) before
 *  answering — the timeout only bounds a truly-stalled connection. */
export async function wakeInstance(
  auth: ConciergeAuth,
  timeoutMs = 150_000,
): Promise<{ ok: boolean; detail?: string }> {
  const headers = await authHeaders(auth);
  if (!headers.Authorization) {
    return { ok: false, detail: "no betterbase session — connect your store to wake the enclave" };
  }
  try {
    const res = await fetch(`${CONCIERGE_URL}/wake`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ instance: "waddle" }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) return { ok: true };
    const body = await res.text().catch(() => "");
    return { ok: false, detail: `concierge refused (${res.status}) ${body.slice(0, 120)}` };
  } catch (e) {
    const stalled = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    return {
      ok: false,
      detail: stalled
        ? `concierge stalled — wake gave up after ${Math.round(timeoutMs / 1000)}s (deploy still running?)`
        : "concierge unreachable — is it running?",
    };
  }
}

/** Poll the enclave's /health until it answers (~2s per attempt). */
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

/** Ask the pool for a warm standby URL — null when none, or when the
 *  handed-out host is outside the primary's zone (the TOFU pin travels
 *  by measurement, so it cannot catch a host switch). */
export async function assignStandby(auth: ConciergeAuth, zone: string): Promise<string | null> {
  if (!zone) return null; // no zone to bind to — never accept a host unbound
  try {
    const res = await fetch(`${CONCIERGE_URL}/assign`, {
      headers: await authHeaders(auth),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const m = (await res.json().catch(() => null)) as { url?: string } | null;
    const host = m && typeof m.url === "string" ? new URL(m.url).hostname : "";
    return host.endsWith(zone) ? m!.url! : null;
  } catch {
    return null; // concierge unreachable — caller falls back to /wake
  }
}
