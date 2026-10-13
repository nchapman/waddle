/**
 * @waddle/sdk — the wire contract between the gateway (VM), clients,
 * and the concierge. Both ends of every protocol in this repo import
 * their types from here: if it crosses a process boundary, it lives in
 * this file.
 */

export interface HelloResponse {
  service: "waddle-server";
  version: string;
  /** Pre-unlock, only the unlock endpoint exists (the lock screen). */
  locked: boolean;
  /** "memory" = no writable storage mounted; enrollment is per-boot. */
  storage?: "disk" | "memory";
  /** The enclave runtime's own hostname — platform fact: on tinfoil it is
   *  expected to equal the instance name (the machine self-identity key,
   *  PLAN.md cattle). Diagnostic for now; the identity fix keys on it. */
  hostname?: string;
}

export type GatewayEvent =
  | { type: "hello"; hello: HelloResponse }
  | { type: "message"; id?: string; at?: string; role: "user" | "assistant"; text: string }
  | { type: "tool_start"; callId: string; tool: string; args: unknown; at?: string }
  | { type: "tool_end"; callId: string; tool: string; result: unknown; isError: boolean; at?: string }
  | { type: "approval_request"; callId: string; tool: string; input: unknown; at?: string }
  | { type: "approval"; callId: string; tool: string; approved: boolean; at?: string }
  | { type: "run_settled"; at?: string }
  /** Restored-history row (device snapshot or betterbase pull, sealed on relay). */
  | { type: "history_row"; role: "user" | "assistant" | "tool"; text: string; at?: string }
  | { type: "history_restored"; count: number }
  | { type: "preference"; background: boolean }
  | { type: "session_restored"; staged: boolean }
  | { type: "sleep_proposed"; reason: string }
  /** The user took/release interactive control of the shared browser. Only
   *  control transitions are sealed/broadcast — never input events
   *  themselves (keystrokes must not become history). */
  | { type: "browser_control"; held: boolean; at?: string }
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

/** Scoped betterbase credentials so the enclave can shelf + restore its
 *  own machine backups. Built by the client at unlock (epoch key wrapped
 *  under the unlock secret); opaque to everything in between. */
export interface BbGrant {
  /** Sync base URL, enclave-reachable (e.g. https://sync.example.com/api/v1). */
  endpoint: string;
  /** Bearer token for the sync API. */
  token: string;
  /** Personal space uuid. */
  spaceId: string;
  /** Current epoch number (wrapped-DEK prefix). */
  epoch: number;
  /** Record id the files API requires uploads to reference (anchor). */
  anchorId: string;
}

/** POST /unlock — the client's 64-byte secret, delivered only after attestation. */
export interface UnlockRequest {
  /** 64 random bytes, base64. The root of all server-side key material. */
  secret: string;
  /** Per-unlock nonce, base64 — binds the session credential to this transcript. */
  nonce: string;
  /** Inference API key — rides the attested unlock, memory-only on the server. */
  inferenceKey?: string;
  /** Machine-shelf grant when the user is signed in to betterbase. */
  bb?: BbGrant;
  /** The delegation preference (client is source of truth while present). */
  background?: boolean;
  /** The machine the CLIENT believes it is unlocking — the /boot-given
   *  enclave's first hostname label. The machine relays it at the
   *  concierge handshake, which mints only when it matches the user's
   *  registry row (fail-closed: mismatch = wrong machine, re-boot). */
  instance?: string;
}

export interface UnlockResponse {
  /** Bearer token for gated endpoints + the WSS (?token=…). */
  token: string;
  /** True when this unlock initialized a fresh volume (enrollment). */
  enrolled: boolean;
  /** The machine's delegation preference (snapshot-carried across boots). */
  background?: boolean;
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
  /** Stop the active run (deny pending approvals, abort, settle). No-op when idle. */
  | { type: "stop" }
  | { type: "approval_response"; callId: string; approved: boolean }
  /** Relay a decrypted snapshot into the fresh enclave's sealed log. */
  | { type: "history_restore"; rows: Array<{ role: "user" | "assistant" | "tool"; text: string }> }
  // Native resume: the client relays the backed-up pi session transcript
  // (its own JSONL) so the agent boots with full context, not a digest.
  | { type: "session_restore"; jsonl: string }
  /** The user's hands: normalized input for the enclave browser. Transient —
   *  never sealed into the log. */
  | { type: "browser_input"; events: BrowserInputEvent[] }
  /** Explicit hand-back (auto-releases on input idle too). */
  | { type: "browser_release" }
  /** The delegation switch (two-tier autonomy) — live from the header. */
  | { type: "preference"; background: boolean };

/** One user-input event over the wire: normalized coordinates (against the
 *  frame the client sees), DOM key names, or a batched printable run. The
 *  server's input-map consumes these; they are NEVER sealed into the log. */
export type BrowserInputEvent =
  | { t: "move"; x: number; y: number }
  | { t: "down"; x: number; y: number; b?: "left" | "right" | "middle" }
  | { t: "up"; x: number; y: number; b?: "left" | "right" | "middle" }
  | { t: "wheel"; dx: number; dy: number; x?: number; y?: number }
  | { t: "key"; k: string; up?: boolean } // control key (or modifier) press/release
  | { t: "text"; s: string }; // batched printable run (≤ 64 chars)

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

// ── Concierge wire ─────────────────────────────────────────────────────
// The always-on lifecycle timer: a table of {instance, action, due} rows
// plus memory-only escrows. Writes are POST with `instance` in the body
// (no URL-borne secrets); the read-only /health, /boot/ready, /status
// are GET (boot/ready and status carry their bearer in the header).
// Auth tiers:
//   external  bb JWT or shared secret  (/boot/ready /status)
//   jwt-user  bb JWT, sub-identifying  (/boot — the discovery/wake verb)
//   session   handshake-minted token   (/timer /handoff/post /handoff/post/pull)
//   secret    shared secret only       (/handshake bearer — it mints sessions;
//                                       /handoff, /handoff/pull — machine verbs that move the master secret)

export interface HandshakeRequest {
  instance: string;
  /** The machine's name as the CLIENT stated it (from /boot). The JWT
   *  tier mints only when this matches the caller's registry row —
   *  fail-closed against a stale/wrong caller. */
  presented_instance?: string;
}
export interface HandshakeResponse {
  session_token: string;
  /** The concierge-resolved machine name — the session's table key.
   *  The machine adopts it (cattle identity: machines are shared-secret
   *  twins; only the caller's registry row distinguishes them). */
  instance?: string;
}

/** POST /timer — the table write. Replace semantics ARE the policy:
 *  stop rows are singleton-per-instance (debounce), wake rows are
 *  job-keyed one-shots. due_ms is relative (skew-immune); 0 cancels. */
export interface TimerRequest {
  instance: string;
  action: "stop" | "wake";
  /** ms from now; 0 cancels (per-job for wake rows). */
  due_ms: number;
  job_id?: string;
}
export type RowWrite = "replaced" | "cleared";
export interface TimerResponse {
  ok: boolean;
  stop?: RowWrite;
  wake?: RowWrite;
  job_id?: string;
}

/** POST /handoff — arm/clear the wake-credential escrow (memory-only).
 *  `credential` is an opaque bag (today: { secret, schedules[], snapshot? }). */
export interface HandoffArmRequest {
  instance: string;
  credential?: Record<string, unknown>;
  ttl_ms?: number;
  clear?: boolean;
}
export interface HandoffArmResponse {
  ok: boolean;
  expires_in_ms?: number;
  cleared?: boolean;
}

/** POST /handoff/pull — a just-booted locked machine asks for its
 *  credential; 404 unless a wake row fired for it (the fire-gate). */
export interface HandoffPullRequest {
  instance: string;
}
export interface HandoffPullResponse {
  credential: Record<string, unknown>;
  /** The served row's machine name — a wake boot adopts it (it can't
   *  know its own name; the escrow row is the concierge's own record). */
  instance?: string;
}

/** POST /handoff/post — sealed return mail from an autonomous run. */
export interface PostboxPostRequest {
  instance: string;
  blob?: string;
  clear?: boolean;
}
export interface PostboxPostResponse {
  ok: boolean;
  expires_in_ms?: number;
  cleared?: boolean;
}
export interface PostboxPullRequest {
  instance: string;
}
export interface PostboxPullResponse {
  blob: string;
}


/** POST /boot — the client's discovery verb: "my machine, running".
 *  `fresh: true` = the client watched the previous machine die (it stops
 *  mid-session) — mint a new name rather than rebind: the old name's
 *  NXDOMAIN may sit in the browser's own DNS cache for the SOA negative
 *  TTL, and a blank machine is cheap (the shelf holds all state). */
export interface BootRequest {
  fresh?: boolean;
}
export interface BootResponse {
  instance: string;
  url: string;
  status: "running" | "waking";
  detail: string;
}
/** GET /boot/ready?instance=X — the client's readiness poll. It hits the
 *  CONCIERGE (always-on, its name never poisoned) instead of the booting
 *  machine: the browser must not query the machine's name until the
 *  record is live, or it poisons its own resolver for the negative TTL.
 *  200 = the machine is Running (tinfoil) AND its DNS resolves
 *  (concierge-side, cache-free c-ares); 503 = not yet. The /health
 *  reachability check is deliberately NOT here — the concierge's egress
 *  cannot reach instance hosts; the client does it once the record is
 *  live, when a failure is a refusal, never a cacheable NXDOMAIN. */
export interface BootReadyResponse {
  instance: string;
  ready: boolean;
}
