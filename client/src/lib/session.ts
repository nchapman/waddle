/**
 * Client-side session: generate and hold the 64-byte secret, deliver it
 * only through the attested (EHBP-encrypted) verified fetch, keep the
 * returned bearer token for gated calls + the WSS.
 *
 * PROTOTYPE CUSTODY NOTE: the secret lives in localStorage for First
 * Light. Real custody (passphrase wrap / OS keystore) comes later —
 * the wire protocol does not change when it does.
 */
import type { BbGrant, UnlockResponse, StateResponse } from "@waddle/sdk";
import { DEV } from "./config";

/** Structural: the attested SecureClient in prod, plain fetch in dev parity mode. */
export type VerifiedFetcher = { fetch: typeof fetch };

const SECRET_KEY = "waddle.secret";
const TOKEN_KEY = "waddle.token";
const INFERENCE_KEY = "waddle.inferenceKey";

export function getInferenceKey(): string {
  return localStorage.getItem(INFERENCE_KEY) ?? "";
}

export function setInferenceKey(key: string): void {
  localStorage.setItem(INFERENCE_KEY, key);
}

function b64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

export function getSecret(): string {
  let s = localStorage.getItem(SECRET_KEY);
  if (!s) {
    s = b64(crypto.getRandomValues(new Uint8Array(64)));
    localStorage.setItem(SECRET_KEY, s);
  }
  return s;
}

export function forgetSecret(): void {
  localStorage.removeItem(SECRET_KEY);
  localStorage.removeItem(TOKEN_KEY);
}
export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export async function unlock(
  client: VerifiedFetcher,
  enclaveURL: string,
  inferenceKey?: string,
  bb?: BbGrant,
  background?: boolean,
): Promise<UnlockResponse & { background?: boolean }> {
  const nonce = b64(crypto.getRandomValues(new Uint8Array(16)));
  const res = await client.fetch(`${enclaveURL}/unlock`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      secret: getSecret(),
      nonce,
      ...(inferenceKey ? { inferenceKey } : {}),
      ...(bb ? { bb } : {}),
      ...(background !== undefined ? { background } : {}),
      // The machine's name (first hostname label of the enclave URL):
      // the concierge's handshake mints only when this matches the
      // user's registry row — the caller must name its machine. Dev
      // (compose, localhost) has no registry — omit and use the
      // shared-secret tier like always.
      ...(DEV ? {} : { instance: new URL(enclaveURL).hostname.split(".")[0] }),
    }),
  });
  const body = (await res.json()) as UnlockResponse & { background?: boolean; error?: string };
  if (!res.ok) throw new Error(body.error ?? `unlock failed (${res.status})`);
  localStorage.setItem(TOKEN_KEY, body.token);
  return body;
}

export async function getState(
  client: VerifiedFetcher,
  enclaveURL: string,
): Promise<StateResponse> {
  const res = await client.fetch(`${enclaveURL}/state`, {
    headers: { Authorization: `Bearer ${getToken() ?? ""}` },
  });
  const body = (await res.json()) as StateResponse & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `state failed (${res.status})`);
  return body;
}
