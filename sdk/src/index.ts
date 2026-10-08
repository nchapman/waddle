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
  | { type: "message"; id?: string; at?: string; role: "user" | "assistant"; text: string }
  | { type: "tool_start"; callId: string; tool: string; args: unknown; at?: string }
  | { type: "tool_end"; callId: string; tool: string; result: unknown; isError: boolean; at?: string }
  | { type: "approval_request"; callId: string; tool: string; input: unknown; at?: string }
  | { type: "approval"; callId: string; tool: string; approved: boolean; at?: string }
  | { type: "run_settled"; at?: string }
  /** Restored-history row (device snapshot or betterbase pull, sealed on relay). */
  | { type: "history_row"; role: "user" | "assistant" | "tool"; text: string; at?: string }
  | { type: "history_restored"; count: number }
  | { type: "session_restored"; staged: boolean }
  | { type: "sleep_proposed"; reason: string }
  | { type: "sleep_cancelled"; reason: string }
  | { type: "sleep"; reason: string; at?: string }
  /** Marks the end of the initial backlog replay; live events follow. */
  | { type: "replay_done"; count: number }
  /** Live browser frame (jpeg data URL) — ephemeral broadcast, never logged. */
  | { type: "frame"; data: string; seq: number }
  /** Browser navigation/status: what the enclave's Chromium is showing. */
  | { type: "browser_status"; url: string; title: string; live: boolean };

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

/** Client → server intent (WSS inbound). Inbound is always intent, never history. */
export type UserIntent =
  | { type: "user_message"; text: string }
  | { type: "sleep_now" }
  | { type: "approval_response"; callId: string; approved: boolean }
  /** Relay a decrypted snapshot into the fresh enclave's sealed log. */
  | { type: "history_restore"; rows: Array<{ role: "user" | "assistant" | "tool"; text: string }> }
  // Native resume: the client relays the backed-up pi session transcript
  // (its own JSONL) so the agent boots with full context, not a digest.
  | { type: "session_restore"; jsonl: string };

/** Live stream chunk (transient — final message events are the persisted truth). */
export interface DeltaEvent {
  type: "delta";
  messageId: string;
  text: string;
}

export interface ErrorEvent {
  type: "error";
  message: string;
}
