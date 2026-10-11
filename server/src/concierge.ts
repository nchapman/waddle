/**
 * Concierge client — the agent's pen for the timer table.
 *
 * Handshake once per boot (betterbase grant token, fresh at unlock; dev
 * shared secret otherwise) → session token → table writes. All calls are
 * best-effort and report success: the sleep gate refuses to die into a
 * missed schedule, and everything else (stop debounce) self-heals on the
 * next activity. No import from index.ts (circular): logs to stdout in
 * the pino shape so the ring picks them up.
 */
import type { Schedule } from "./schedules.js";
import type {
  HandshakeResponse,
  HandoffArmResponse,
  HandoffPullResponse,
  PostboxPostResponse,
  PostboxPullResponse,
  TimerRequest,
  TimerResponse,
} from "@waddle/sdk";

const CONCIERGE_URL = process.env.CONCIERGE_URL ?? "";
/** CATTLE IDENTITY: the machine cannot know its own name (hostname is
 *  the inner container id — live-proven v0.0.49; per-boot env changes
 *  the measurement). It starts on the baked/boot default and ADOPTS
 *  the name the concierge resolves for it — the registry row at
 *  handshake, or the escrow row at the wake-boot pull. Until adopted,
 *  pre-unlock verbs ride the legacy shared key (k=1, documented) — and identify as "unadopted", which the
 * concierge's namespace gates refuse: an unnamed machine has no
 * identity, by design. */
export const UNADOPTED = "unadopted";
let INSTANCE = process.env.WADDLE_INSTANCE ?? UNADOPTED;
const NAME_SHAPE = /^[a-z0-9][a-z0-9-]{0,62}$/;
function adoptInstance(name: unknown): void {
  if (typeof name === "string" && NAME_SHAPE.test(name) && name !== INSTANCE) {
    log("instance adopted", { instance: name });
    INSTANCE = name;
  }
}

/** The machine's current name — adopted from the concierge when known,
 *  the baked/boot default until then. Test-facing (module state); every
 *  POST body this module sends keys on it. The seal AADs are
 *  instance-free constants (postbox/snapshot v2). */
export function currentInstance(): string {
  return INSTANCE;
}
/** Stop-row backstop offset: the stop row is a zombie backstop, never
 *  the primary sleep path — arm it just past the idle gate (idle +
 *  margin) from the last contact; activity renews, the gate's death
 *  flare replaces it with the real 5 s stop, and a machine that somehow
 *  hangs past its own gate gets reaped. */
function stopBackstopMs(): number {
  const idle = Number(process.env.WADDLE_IDLE_MS ?? 10 * 60_000);
  return idle + 30_000;
}

let sessionToken: string | null = null;

const log = (msg: string, extra?: Record<string, unknown>) =>
  console.log(JSON.stringify({ level: 30, time: Date.now(), module: "concierge-client", msg, ...extra }));

async function post<T>(path: string, body: object, bearer: string): Promise<T | null> {
  if (!CONCIERGE_URL) return null;
  try {
    const res = await fetch(`${CONCIERGE_URL}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ instance: INSTANCE, ...body }),
      signal: AbortSignal.timeout(10_000),
    });
    log(`POST ${path}`, { status: res.status });
    if (res.status === 401) {
      // Session died (concierge rebooted — memory-only by design). Drop it
      // so conciergeActive() goes false: the sleep gate then refuses to die
      // into near dues instead of believing dead wake rows still cover it.
      sessionToken = null;
      return null;
    }
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch (e) {
    log(`POST ${path} failed`, { err: String(e) });
    return null;
  }
}

/** Handshake at unlock — `bearer` is the (fresh) betterbase grant token,
 *  `presented` the machine's name as the CLIENT stated it (from /boot).
 *  The concierge mints only when presented ≡ the user's registry row —
 *  the response's instance is then that confirmed name; adopting it
 *  re-keys every later write (arm, timers) to the real machine. */
export async function handshakeConcierge(bearer: string, presented?: string): Promise<boolean> {
  const body = presented ? { presented_instance: presented } : {};
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${CONCIERGE_URL}/handshake`, {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: JSON.stringify({ instance: INSTANCE, ...body }),
        signal: AbortSignal.timeout(10_000),
      });
      log("POST /handshake", { status: res.status });
      if (res.status === 409 || res.status === 404) {
        // Definitive refusal: wrong machine / no registry row. No retry,
        // no secret-tier fallback — the client must re-boot.
        return false;
      }
      if (res.status === 401) {
        sessionToken = null;
        return false;
      }
      if (res.status === 403) {
        // Definitive, not transient: the concierge refuses this identity
        // (the unadopted sentinel by design; a wrong name at the gate).
        // Retrying would burn the window re-asking a question already
        // answered — fail fast, the caller's own clocks bound the boot.
        return false;
      }
      if (!res.ok) throw new Error(`status ${res.status}`);
      const r = (await res.json()) as HandshakeResponse;
      sessionToken = r.session_token ?? null;
      if (sessionToken && r.instance) adoptInstance(r.instance);
      return sessionToken !== null;
    } catch (e) {
      // Transient (network/5xx): a blip must not read as an identity
      // refusal — the session's idle-stop/delegation ride on this.
      if (attempt >= 3) {
        log("handshake failed after retries", { err: String(e) });
        return false;
      }
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

export function conciergeActive(): boolean {
  return sessionToken !== null;
}

/** One table write. Wake rows are job-keyed one-shots; stop rows replace. */
export async function writeTimer(row: {
  action: "stop" | "wake";
  dueMs: number;
  jobId?: string;
}): Promise<boolean> {
  if (!sessionToken) return false;
  const body: Omit<TimerRequest, "instance"> = { action: row.action, due_ms: row.dueMs, job_id: row.jobId };
  const r = await post<TimerResponse>("/timer", body, sessionToken);
  return r?.ok === true;
}

/** Activity debounce — every contact pushes the backstop out.
 *  NO-OP while unadopted: an identity-less boot has no row key the
 *  concierge would accept (fail-closed by design), and its rows would
 *  fire against nothing. Such boots are bounded by the concierge's
 *  platform clocks instead (standby claim-grace / user 24h sweep). */
export function renewIdleStop(): void {
  if (INSTANCE === UNADOPTED) return;
  void writeTimer({ action: "stop", dueMs: stopBackstopMs() });
}

/** At exit: the platform stop that ends billing + the zombie state.
 *  Awaited by the sleep gate — a fire-and-forget flare loses the race
 *  with the process's own exit timer and billing runs on. */
export async function deathFlare(): Promise<void> {
  await writeTimer({ action: "stop", dueMs: 5_000 });
}

/** Wake-autonomy escrow: park the boot credential in the concierge's
 *  MEMORY (never on this machine's ephemeral disk). The credential is an
 *  opaque bag — today `{ secret, schedules[], snapshot? }`: the master
 *  secret plus due work and a sealed whole-machine snapshot (two-tier
 *  autonomy, the warned opt-in). TTL is the NEXT due schedule + margin
 *  (SME review): the escrow exists to serve a schedule, so it stands
 *  exactly as long — not 7 days. Re-armed at every unlock AND at the
 *  sleep gate, so recurring schedules stay covered without a long-lived
 *  row. */
export async function armHandoff(credential: Record<string, unknown>, bearer: string, ttlMs?: number): Promise<boolean> {
  const r = await post<HandoffArmResponse>("/handoff", { credential, ttl_ms: ttlMs }, bearer);
  return r?.ok === true;
}

/** The wake-boot credential (same shape wakeboot.ts arms): the master
 *  secret, the due schedule rows, an optional sealed snapshot, and —
 *  dev file arm only — an inference key. */
export interface PulledCredential {
  secret?: string;
  schedules?: Schedule[];
  snapshot?: string;
  inferenceKey?: string;
  [k: string]: unknown;
}

/** The wake-boot side of the escrow: ask the concierge for the
 *  credential. POST (no caching, no URL-borne secrets). Auth is the env
 *  shared secret — a locked boot has no session token, exactly like the
 *  locked-boot backstop handshake. */
export async function pullHandoff(): Promise<PulledCredential | null> {
  if (!CONCIERGE_URL) return null;
  try {
    const res = await fetch(`${CONCIERGE_URL}/handoff/pull`, {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.CONCIERGE_SHARED_SECRET ?? ""}`, "content-type": "application/json" },
      body: JSON.stringify({ instance: INSTANCE }),
      signal: AbortSignal.timeout(10_000),
    });
    log("POST /handoff/pull", { status: res.status });
    if (!res.ok) return null;
    const row = (await res.json()) as HandoffPullResponse;
    if (!row.credential || typeof row.credential !== "object") return null;
    // The served row's name is this machine's identity — adopted before
    // the caller touches the credential (the arm + handshake re-key on it).
    adoptInstance(row.instance);
    return row.credential;
  } catch (e) {
    log("POST /handoff/pull failed", { err: String(e) });
    return null;
  }
}

/** Post return mail at the autonomous re-sleep: a blob sealed under a
 *  key derived from the master secret — events + schedule table.
 *  Session-tier auth like every table write. */
export async function postPostbox(blob: string): Promise<boolean> {
  if (!sessionToken) return false;
  const r = await post<PostboxPostResponse>("/handoff/post", { blob }, sessionToken);
  return r?.ok === true;
}

/** Collect + clear the mail at unlock. Returns the sealed blob or null
 *  (no mail / unreachable — both normal). */
export async function pullPostbox(): Promise<string | null> {
  if (!sessionToken) return null;
  const r = await post<PostboxPullResponse>("/handoff/post/pull", {}, sessionToken);
  return typeof r?.blob === "string" && r.blob ? r.blob : null;
}
