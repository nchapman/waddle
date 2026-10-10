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
const CONCIERGE_URL = process.env.CONCIERGE_URL ?? "";
const INSTANCE = process.env.WADDLE_INSTANCE ?? "waddle";
/** The stop row is a zombie backstop, never the primary sleep path:
 *  arm it just past the idle gate (idle + margin) from the last contact —
 *  activity renews, the gate's death flare replaces it with the real 5 s
 *  stop, and a machine that somehow hangs past its own gate gets reaped. */
export function stopBackstopMs(): number {
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

/** Handshake at unlock — `bearer` is the (fresh) betterbase grant token. */
export async function handshakeConcierge(bearer: string): Promise<boolean> {
  const r = await post<{ session_token: string }>("/handshake", {}, bearer);
  sessionToken = r?.session_token ?? null;
  return sessionToken !== null;
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
  const r = await post<{ ok: boolean }>("/timer", { ...row, due_ms: row.dueMs, job_id: row.jobId }, sessionToken);
  return r?.ok === true;
}

/** Activity debounce — every contact pushes the backstop out. */
export function renewIdleStop(): void {
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
 *  opaque bag — today `{ autonomyKey, schedules[] }`: a schedule-scoped
 *  derived key (never the master) plus the due work itself. TTL is the
 *  NEXT due schedule + margin (SME review): the escrow exists to serve a
 *  schedule, so it stands exactly as long — not 7 days. Re-armed at every
 *  unlock AND at the sleep gate, so recurring schedules stay covered
 *  without a long-lived row. */
export async function armHandoff(credential: Record<string, unknown>, bearer: string, ttlMs?: number): Promise<boolean> {
  const r = await post<{ ok: boolean }>("/handoff", { credential, ttl_ms: ttlMs }, bearer);
  return r?.ok === true;
}

export interface PulledCredential {
  autonomyKey?: string;
  schedules?: Array<Record<string, unknown>>;
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
    const row = (await res.json()) as { credential?: PulledCredential };
    if (!row.credential || typeof row.credential !== "object") return null;
    return row.credential;
  } catch (e) {
    log("POST /handoff/pull failed", { err: String(e) });
    return null;
  }
}

/** Post return mail at the autonomous re-sleep: a blob sealed under
 *  HKDF(autonomyKey, "postbox") — events + schedule table. Session-tier
 *  auth like every table write. */
export async function postPostbox(blob: string): Promise<boolean> {
  if (!sessionToken) return false;
  const r = await post<{ ok: boolean }>("/handoff/post", { blob }, sessionToken);
  return r?.ok === true;
}

/** Collect + clear the mail at unlock. Returns the sealed blob or null
 *  (no mail / unreachable — both normal). */
export async function pullPostbox(): Promise<string | null> {
  if (!sessionToken) return null;
  const r = await post<{ blob?: string }>("/handoff/post/pull", {}, sessionToken);
  return typeof r?.blob === "string" && r.blob ? r.blob : null;
}
