/**
 * @waddle/sdk — the wire contract between the gateway (VM) and clients.
 *
 * One append-only event log per VM. Clients attach: replay from a cursor,
 * then stream live. Clients send intents only — never history.
 * (Phase 1 replaces these stubs with the full protocol.)
 */

export interface HelloResponse {
  service: "waddle-server";
  version: string;
  /** Pre-unlock, only the unlock endpoint exists (the lock screen). */
  locked: boolean;
  /** "memory" = no writable storage mounted; enrollment is per-boot. */
  storage?: "disk" | "memory";
}

export type GatewayEvent =
  | { type: "hello"; hello: HelloResponse }
  | { type: "task_started"; taskId: string; goal: string }
  | { type: "message"; eventId: string; role: "user" | "assistant"; text: string }
  | { type: "sleep_proposed"; reason: string }
  | { type: "sleep_cancelled"; reason: string };

export function hello(
  version: string,
  locked = false,
  storage: "disk" | "memory" = "disk",
): HelloResponse {
  return { service: "waddle-server", version, locked, storage };
}

/** POST /unlock — the client's 64-byte secret, delivered only after attestation. */
export interface UnlockRequest {
  /** 64 random bytes, base64. The root of all server-side key material. */
  secret: string;
  /** Per-unlock nonce, base64 — binds the session credential to this transcript. */
  nonce: string;
}

export interface UnlockResponse {
  /** Bearer token for gated endpoints + the WSS (?token=…). */
  token: string;
  /** True when this unlock initialized a fresh volume (enrollment). */
  enrolled: boolean;
}

/** GET /state — post-unlock proof-of-life for the session. */
export interface StateResponse {
  unlocked: true;
  enrolled: boolean;
  events: Array<Record<string, unknown>>;
}
