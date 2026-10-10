/**
 * Waddle server — a single-user app in a secure container.
 * Lock screen: /health + /unlock exist pre-unlock; everything else is
 * gated on the session credential derived from the unlock transcript.
 */
import fastify from "fastify";
import websocket from "@fastify/websocket";
import cors from "@fastify/cors";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { hello, type GatewayEvent, type UnlockRequest, type UnlockResponse, type StateResponse, type UserIntent } from "@waddle/sdk";
import { Lock, freshNonce } from "./state.js";
import { EventLog } from "./log.js";
import { initAgent, chat, agentReady, stageSessionJsonl, stageHistoryRows, setBlackbox, setSink, getSessionJsonl } from "./agent.js";
import { resolveApproval, denyAllPending, setOutcomeEmitter } from "./approvals.js";
import { setBrowserEvents, browserLive, captureNow, userInput, releaseUserControl, setControlNotifier, stopBrowser } from "./browser.js";
// (createArchive/restoreArchive live behind bb-backup.ts now; the old
// debug GET /archive is gone — machine bytes never travel unsealed)
import { setBbGrant, clearBbGrant, bbGrantActive, pushMachineBackup, pullMachineBackup, pruneOldGens } from "./bb-backup.js";
import { createSchedule, listSchedules, cancelSchedule, markRun, dueSchedules, dueSoon, activeSchedules, nextDueMs, replaceAllSchedules, seedSchedules, type Schedule } from "./schedules.js";
import { handshakeConcierge, conciergeActive, renewIdleStop, deathFlare, writeTimer, armHandoff, pullHandoff, postPostbox, pullPostbox } from "./concierge.js";
import { autonomyEnabled, armWakeCredential, readWakeCredential, clearWakeCredential } from "./wakeboot.js";
import { sealPostbox, openPostbox, mergeSchedules, schedulableRows } from "./postbox.js";
import { sealSnapshot, openSnapshot } from "./snapshot.js";
import { getPreferences, setPreferences, backgroundTasksEnabled } from "./preferences.js";
import { createArchive, restoreArchive } from "./archive.js";

/** Reject after ms — bounds restore/final-backup so nothing hangs the boot or the exit. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

// Quiet sink: no client attached — the sealed log is the truth, finals and
// tools persist, deltas drop. Shared by mid-turn disconnects and scheduled
// work firing with nobody watching.
function applyQuietSink() {
  setSink({
    onToolStart: (callId, tool, args) => {
      touch(); // work in flight is activity, watched or not
      log?.append({ type: "tool_start", callId, tool, args, at: new Date().toISOString() });
    },
    onToolEnd: (callId, tool, result, isError) => {
      touch();
      log?.append({ type: "tool_end", callId, tool, result, isError, at: new Date().toISOString() });
    },
    onAssistantFinal: (text) => {
      touch();
      log?.append({ type: "message", role: "assistant", text, at: new Date().toISOString() });
    },
  });
}

// Scheduled work: fires whether or not anyone is watching. markRun first
// (recurring realigns, one-shot exhausts), then the prompt rides the normal
// chat path — tools, approvals (auto-denied with no client), and the log
// records the story; the next shelf push carries it.
let firing = false;
async function fireSchedule(s: Schedule): Promise<void> {
  app.log.info({ id: s.id, title: s.title }, "schedule firing");
  markRun(s.id);
  log?.append({ type: "message", role: "user", text: `[scheduled: ${s.title}] ${s.prompt}`, at: new Date().toISOString() });
  if (sockets.size === 0) applyQuietSink();
  try {
    await chat(`[scheduled task "${s.title}"] ${s.prompt}`);
  } catch (e) {
    app.log.warn({ err: String(e), id: s.id }, "scheduled run failed");
    log?.append({ type: "message", role: "assistant", text: `scheduled run failed: ${e instanceof Error ? e.message : String(e)}`, at: new Date().toISOString() });
  }
}

setInterval(() => {
  if (sleeping || refusing || !lock.unlocked || firing) return;
  const due = dueSchedules();
  if (due.length === 0 || !agentReady()) return;
  firing = true;
  void (async () => {
    try {
      for (const s of due) await fireSchedule(s);
    } finally {
      firing = false; // a stuck-true latch would kill the ticker AND the sleep gate
    }
  })();
}, 10_000).unref();

const PORT = Number(process.env.PORT ?? 8080);
const VERSION = "0.0.1";
const INSTANCE = process.env.WADDLE_INSTANCE ?? "waddle";

// Ring buffer of recent log lines — tinfoil gives us no logs/exec, so the
// session-gated /debug/log endpoint is the only window into a live enclave.
// Secrets never enter the ring: the default request serializer logs full
// URLs, and the client carries its session bearer in the /ws query string —
// ring lines are expected to be copied into bug reports and screenshots.
const logRing: string[] = [];
const RING_MAX = 400;
const REDACT_TOKEN = /([?&\s]token=)[^"&\s]+/g;
const REDACT_AUTH = /([Aa]uthorization"?:? ?"?Bearer )[^"\s]+/g;
const tee = {
  write: (line: string) => {
    process.stdout.write(line);
    logRing.push(line.replace(REDACT_TOKEN, "$1<redacted>").replace(REDACT_AUTH, "$1<redacted>").trimEnd());
    if (logRing.length > RING_MAX) logRing.shift();
  },
};

const app = fastify({ logger: { level: "info", stream: tee } });
await app.register(websocket);

// Browser clients talk to us cross-origin (dev: Vite on :5173; prod: the client host).
await app.register(cors, {
  origin: (process.env.ALLOWED_ORIGINS ?? "http://localhost:5173").split(","),
});

const lock = new Lock();
let log: EventLog | null = null; // non-null from first successful unlock

// Crash black box — set once the log exists (post-unlock). Sync-append so it
// survives the death of the process that wrote it.
const crashLog = (origin: string) => (err: unknown) => {
  const message = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
  try {
    log?.append({ type: "crash", origin, message: message.slice(0, 4000), at: new Date().toISOString() });
  } catch {
    /* the log itself may be the problem */
  }
  app.log.error({ origin, message }, "unhandled");
};
process.on("uncaughtException", crashLog("uncaughtException"));
process.on("unhandledRejection", crashLog("unhandledRejection"));
setBlackbox((message) => log?.append({ type: "boot_error", message: message.slice(0, 4000), at: new Date().toISOString() }));

function requireSession(request: { headers: Record<string, unknown> }, token?: string): boolean {
  const auth = request.headers.authorization;
  const bearer = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : token;
  return lock.verify(bearer);
}

app.get("/health", async () => hello(VERSION, !lock.unlocked, lock.storage));

// Platform facts (no user data): what the enclave runtime lets us do.
// Feeds the Docker-in-Docker feasibility question — caps, seccomp, mounts.
app.get("/probe", async () => {
  const read = (p: string) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  };
  const status = read("/proc/self/status") ?? "";
  const cap = /CapEff:\s*(\w+)/.exec(status)?.[1] ?? "?";
  const seccomp = /Seccomp:\s*(\d+)/.exec(status)?.[1] ?? "?";
  const nnp = /NoNewPrivs:\s*(\d+)/.exec(status)?.[1] ?? "?";
  const cgroupLine = (read("/proc/mounts") ?? "")
    .split("\n")
    .find((l) => l.includes("cgroup"));
  return {
    uid: process.getuid?.(),
    capEff: `0x${cap}`,
    capabilities: Number.parseInt(cap, 16) === 0 ? "none" : "some",
    seccomp: seccomp,
    noNewPrivs: nnp,
    cgroupMount: cgroupLine ?? "none visible",
    dataDirWritable: lock.storage,
    node: process.version,
  };
});

// The whole-machine backup: opaque tar.gz of the working directory.
// GET (session-gated) for the client's sleep/periodic shelf-run; POST
// (session-gated, fresh-log-only) restores a machine before anything
// boots. The client is a pipe — it never opens the blob.
app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
app.post("/unlock", async (request, reply) => {
  const { secret, nonce, inferenceKey, bb, background } = (request.body ?? {}) as UnlockRequest & {
    inferenceKey?: string;
    background?: boolean;
    bb?: import("./bb-backup.js").BbGrant;
  };
  if (!secret || !nonce) return reply.code(400).send({ error: "secret and nonce required" });
  try {
    const { token, enrolled } = lock.unlock(secret, nonce);
    // A user unlocking is a takeover: whatever restricted autonomous state
    // this machine booted into, a live user session outranks it. The flag
    // is captured first — a takeover machine must not merge its own mail
    // (its events are already live in this log).
    const wasAutonomous = autonomous;
    if (autonomous) {
      // Takeover: one key domain, one log — the autonomous session's
      // transcript is already in the master-sealed log (the boot restored
      // it). A live user session outranks the autonomous flag, that's all.
      autonomous = false;
      log?.append({ type: "message", role: "user", text: "[system] user unlock — autonomous session taken over", at: new Date().toISOString() });
    }
    if (!log) log = new EventLog(lock.logKey, lock.storage);
    // The clock starts the moment the machine wakes to a client — never
    // sooner (boot), never mid-restore (restoring guard below).
    restoring = true;
    touch();
    // The machine-shelf grant (if the client is signed in to betterbase):
    // unwrap the epoch key in memory, and on a fresh enclave restore the
    // whole machine from the shelf BEFORE this unlock returns — the
    // client's next /state read sees the restored history and seeds from
    // it like any live boot. Restore failures never brick the unlock.
    if (bb) {
      try {
        await setBbGrant(secret, bb);
        app.log.info({ endpoint: bb.endpoint, space: bb.spaceId, epoch: bb.epoch, anchor: bb.anchorId, tokenLen: bb.token?.length ?? 0 }, "[dbg] bb grant armed");
      } catch (e) {
        app.log.warn({ err: String(e) }, "bb grant rejected — backups disabled this session");
        clearBbGrant();
      }
      app.log.info({ active: bbGrantActive(), fresh: (log?.all ?? []).every((e) => e.type === "sleep"), events: (log?.all ?? []).length }, "[dbg] restore gate");
      if (bbGrantActive() && (log?.all ?? []).every((e) => e.type === "sleep")) {
        try {
          // Freshness is re-checked inside the pull right before the tree
          // swap — a restore that outlives this window must never wipe a
          // machine that started living in the meantime.
          const fresh = () => (log?.all ?? []).every((e) => e.type === "sleep");
          const pulled = await withTimeout(pullMachineBackup(fresh), 60_000, "restore timeout");
          if (pulled) {
            log = new EventLog(lock.logKey, lock.storage);
            app.log.info({ gen: pulled.gen, events: log.all.length }, "machine restored from shelf");
          }
        } catch (e) {
          app.log.warn({ err: String(e) }, "machine restore failed — booting fresh");
        }
      }
      // First checkpoint of the session (also heals a restore that found
      // nothing — an empty machine shelves its empty state once). A quick
      // retry covers first-run timing: the anchor record the files API
      // references may still be syncing to the server when this fires.
      if (bbGrantActive()) {
        const first = () =>
          pushMachineBackup()
            .then((r) => app.log.info({ pushed: r.pushed, fp: r.digest.slice(0, 12) }, "initial backup"))
            .catch((e) => {
              app.log.warn({ err: String(e) }, "initial backup failed — retrying in 30s");
              setTimeout(() => {
                if (!sleeping && bbGrantActive()) {
                  void pushMachineBackup().catch(() => undefined);
                }
              }, 30_000).unref();
            });
        void first();
      }
    }
    // Timer-table handshake: the bb grant token is fresh right now — the
    // one moment the agent can authenticate to the concierge with it
    // (session tokens thereafter). Dev falls back to the shared secret.
    // Handshake: prefer the fresh bb JWT (JWKS-verified concierges); fall
    // back to the shared secret (tonight's concierge has no JWKS). Whatever
    // worked is what a wake-boot should re-try, so resolve it first.
    const sharedSecret = process.env.CONCIERGE_SHARED_SECRET;
    const bearer = await (async () => {
      if (bb?.token && (await handshakeConcierge(bb.token))) return bb.token;
      if (sharedSecret && (await handshakeConcierge(sharedSecret))) return sharedSecret;
      return undefined;
    })();
    app.log.info({ ok: bearer !== null, via: bearer === bb?.token ? "jwt" : bearer ? "shared-secret" : "none" }, "concierge handshake");
    if (bearer) renewIdleStop();
    // Collect the postbox BEFORE the ticker can fire: an unattended run's
    // mail carries its done-markers, and without them the restored shelf
    // copy of the schedule would look still-due and re-fire (duplicate).
    // The merge is awaited — the unlock response already includes it.
    if (!wasAutonomous) {
      try {
        const blob = await pullPostbox();
        if (blob) {
          // Raw secret both sides: sealPostbox/openPostbox each derive
          // HKDF(secret,"waddle/postbox") internally — feeding a derived
          // key here would double-derive and never open (review catch).
          const payload = openPostbox(secret, INSTANCE, blob);
          for (const e of payload.events) log?.append(e);
          replaceAllSchedules(mergeSchedules(listSchedules(), payload.schedules, payload.cancelledIds ?? []));
          log?.append({ type: "message", role: "user", text: `[system] postbox merged — ${payload.events.length} events from the unattended run delivered`, at: new Date().toISOString() });
          app.log.info({ events: payload.events.length, schedules: payload.schedules.length }, "postbox merged into session");
        }
      } catch (e) {
        // Mail is consumed either way; undecryptable (rotated master?) or
        // unreachable mail degrades to the pre-postbox behavior — the
        // schedule re-fires from the shelf. Honest, not silent.
        app.log.warn({ err: String(e) }, "postbox merge failed — degrading to re-fire delivery");
      }
    }
    // Two-tier autonomy: remember the secret in memory so the SLEEP gate
    // can arm {secret, schedules, sealed snapshot}. Arming happens only
    // at sleep (machine state is at rest there); the escrow serves
    // schedules and has no other reason to stand.
    armSecret = secret;
    armInferenceKey = inferenceKey ?? null;
    // The delegation preference rides the unlock (client is the source of
    // truth while the user is present; the snapshot carries it across boots).
    if (typeof background === "boolean" && background !== getPreferences().background) {
      // Same discipline as the WS handler: a failed persistence (memory
      // storage, read-only/full disk) must never fail an unlock that
      // already succeeded — the machine keeps its previous value.
      try {
        setPreferences({ background });
      } catch (e) {
        app.log.warn({ err: String(e), background }, "preference write failed at unlock — keeping previous value");
      }
    }
    // The inference key rides the same attested, EHBP-encrypted unlock —
    // memory-only, never on disk, never in config. The agent boots lazily
    // on first use; a persisted pi session file (same scratch as this log)
    // is resumed natively at boot — no digest needed on this path.
    if (inferenceKey) initAgent(inferenceKey);
    restoring = false;
    const prefs = getPreferences();
    const res: UnlockResponse & { background?: boolean } = { token, enrolled, background: prefs.background };
    return res;
  } catch (e) {
    restoring = false;
    const err = e as { statusCode?: number; message: string };
    return reply.code(err.statusCode ?? 500).send({ error: err.message });
  }
});

app.get("/debug/log", async (request, reply) => {
  if (!requireSession(request)) return reply.code(401).send({ error: "locked" });
  return { lines: logRing };
});

app.get("/state", async (request, reply) => {
  if (!requireSession(request)) return reply.code(401).send({ error: "locked" });
  const res: StateResponse = {
    unlocked: true,
    enrolled: lock.enrolled,
    events: log?.all ?? [],
  };
  return res;
});

// The pi session transcript (JSONL) — the client mirrors it in its sealed
// betterbase backup so a fresh enclave can resume the conversation natively.
app.get("/session", async (request, reply) => {
  if (!requireSession(request)) return reply.code(401).send({ error: "locked" });
  try {
    return { jsonl: await getSessionJsonl() };
  } catch (e) {
    return reply.code(500).send({ error: e instanceof Error ? e.message : String(e) });
  }
});

// One agent turn at a time for First Light (pi requires steer/followUp
// semantics for concurrent prompts — that arrives with the real harness).
let streaming = false;

// ── Sleep: the idle gate ────────────────────────────────────────────────
// Unlocked + idle past the gate → checkpoint (the log is already sealed
// per-event) → broadcast → graceful exit. Idleness is the absence of
// ACTIVITY — user messages, tool calls, assistant output — not the
// absence of clients: a silently-open tab is an idle machine. The
// platform's restart policy is `no` (config default), so the instance
// stops — and billing with it. The concierge wakes it.
const IDLE_MS = Number(process.env.WADDLE_IDLE_MS ?? 600_000); // 10 min: a dev override shortens it
const sockets = new Set<import("ws").WebSocket>();

// The Eyes: browser frames + navigation status are broadcast-only (never
// sealed into the log — they are views, not history).
setBrowserEvents({
  onFrame: (data, seq) => {
    const evt = JSON.stringify({ type: "frame", data, seq } satisfies GatewayEvent);
    for (const s of sockets) if (s.readyState === 1) s.send(evt);
  },
  onStatus: (status) => {
    const evt = JSON.stringify({ type: "browser_status", ...status } satisfies GatewayEvent);
    for (const s of sockets) if (s.readyState === 1) s.send(evt);
  },
});
// The activity clock starts at first client contact, NOT at boot: an
// enclave can sit locked for minutes (deploys are slow) before its first
// unlock, and a clock ticking from boot would reap the machine seconds
// into that unlock — mid-restore, before any WebSocket exists (v0.0.38
// shipped exactly that bug: the gate fired mid-unlock and shelf-clobbered
// a live machine with an empty checkpoint).
let lastActivity: number | null = null;
/** Any observable work — unlock, user message, tool call, assistant
 *  output — counts as activity and re-arms the concierge's stop row. */
function touch(): void {
  lastActivity = Date.now();
  renewIdleStop();
}
// Never sleep while an unlock (bb grant + shelf restore + handshake) is
// in flight — the gate has no business racing the machine's own boot.
let restoring = false;
let sleeping = false;
let refusing = false; // sleep gate is holding the machine alive (no wake cover)

async function sleep(reason: string): Promise<never> {
  if (sleeping) await new Promise(() => {}); // already going down
  // Refusal: booked work with near dues needs wake rows; without a live
  // concierge (or without wake autonomy — a wake-boot that can't unlock
  // just burns compute until the sweep reaps it), dying = missing the run.
  // Stay alive instead; the gate re-proposes, WADDLE_STAYALIVE=0 forces
  // sleep anyway.
  if ((!conciergeActive() || !autonomyEnabled()) && process.env.WADDLE_STAYALIVE !== "0") {
    const soon = dueSoon(Number(process.env.WADDLE_STAYALIVE_HORIZON_MS ?? 3600_000));
    if (soon.length > 0) {
      const titles = soon.map((s) => s.title).join(", ");
      // One notice per refusal stretch — the idle gate re-enters every 10 s.
      if (!refusing) {
        refusing = true;
        app.log.warn({ reason, soon: soon.length }, "sleep refused — schedules pending, no wake cover; staying alive");
        log?.append({ type: "message", role: "assistant", text: `[system] sleep refused: ${soon.length} schedule(s) due soon (${titles}) with no wake cover — staying alive.`, at: new Date().toISOString() });
        for (const peer of sockets) {
          try {
            peer.send(JSON.stringify({ type: "message", role: "assistant", text: `[system] not sleeping: scheduled work pending (${titles}) but nothing can wake me.`, at: new Date().toISOString() }));
          } catch {
            /* peer already gone */
          }
        }
      }
      await new Promise(() => {}); // hold: alive until cover returns or STAYALIVE=0
    }
  }
  refusing = false;
  sleeping = true;
  app.log.info({ reason }, "sleep gate fired");
  log?.append({ type: "sleep", reason, at: new Date().toISOString() });
  for (const s of sockets) {
    try {
      s.send(JSON.stringify({ type: "sleep", reason }));
      s.close();
    } catch {
      /* going down regardless */
    }
  }
  // Final machine checkpoint — the enclave shelves itself on the way
  // down, so auto-shutdown can never lose the session. Stop Chromium first:
  // a live profile is mid-write, and its cookie jar flushes only on exit.
  // Bounded so a hung shelf never blocks the exit; the periodic push ≤ 10min
  // old either way.
  if (bbGrantActive()) {
    await withTimeout(stopBrowser(), 10_000, "browser stop timeout").catch((e) =>
      app.log.warn({ err: String(e) }, "browser stop failed"),
    );
    const final = await withTimeout(pushMachineBackup(), 30_000, "final backup timeout").then(
      (r) => {
        app.log.info({ pushed: r.pushed, fp: r.digest.slice(0, 12) }, "final backup done");
        return r;
      },
      (e) => {
        app.log.warn({ err: String(e) }, "final backup failed");
        return undefined;
      },
    );
    // Pruning is fire-and-forget on the periodic path, but the sleep exit
    // must wait for it — the process dies 500 ms from now.
    if (final?.pushed) {
      await withTimeout(
        pruneOldGens(final.gen, (i) => app.log.info(i, "shelf prune")),
        15_000,
        "shelf prune timeout",
      ).catch(() => undefined);
    }
  }
  // The death flare: our own checkpoint-exit is done; this is the
  // platform-level stop that ends billing + the zombie Running state.
  // Wake rows for every active schedule so the concierge reboots us for
  // the next occurrence. Refusal (no concierge + schedules due soon)
  // already ran above — this path is safe to fire-and-forget.
  // Wake rows are pointless without delegation — a wake-boot with no
  // credential stays locked and burns compute until the sweep reaps it.
  // The arm below writes the credential those rows consume; the two must
  // share one condition (background off = tier 0 = pre-autonomy semantics:
  // near dues hit the stayalive refusal above, far dues re-fire at the
  // next unlock — no concierge involvement either way).
  if (conciergeActive() && autonomyEnabled() && backgroundTasksEnabled()) {
    await deathFlare();
    for (const s of activeSchedules()) {
      const d = nextDueMs(s);
      // Floor at 1 s: due_ms 0 is the concierge's cancel verb, and an
      // overdue row must fire immediately, not vanish.
      if (d !== null) await writeTimer({ action: "wake", dueMs: Math.max(1_000, d - Date.now()), jobId: s.id });
    }
    // AUTONOMOUS SLEEP: post the return mail first. This machine cannot
    // push its transcript to the shelf (no bb grant), so it seals events
    // + the schedule table (done-markers!) under the postbox key and
    // drops the blob on the concierge. The next unlock merges it — the
    // run's output survives the machine, delivered exactly once, and the
    // marked rows stop the duplicate re-fire.
    if (autonomous && armSecret && log) {
      try {
        // This boot's DELTA (the run), not the whole restored transcript —
        // the pre-boot history is already in the user's own sealed log.
        // Tail-cap: a scheduled run is one turn (tens of events), but a
        // pathological transcript must not blow the gateway body limit.
        // If it ever truncates, the mail says so — honest, never silent.
        const MAX_EVENTS = 200;
        const MAX_BLOB = 6 * 1024 * 1024; // gateway accepts 8MiB; stay under
        let events = log.all.slice(bootLogBaseline);
        if (events.length > MAX_EVENTS) {
          events = [
            { type: "message", role: "user", text: `[system] postbox truncated — ${events.length - MAX_EVENTS} of ${events.length} events dropped (tail kept)`, at: new Date().toISOString() },
            ...events.slice(-MAX_EVENTS),
          ];
        }
        // Cancels during the run: seeded-but-now-absent ids. The schedules
        // (done-markers + chained creations) and these tombstones together
        // are the no-re-fire / no-resurrect contract.
        const cancelledIds = [...bootSeededIds].filter((id) => !listSchedules().some((r) => r.id === id));
        let payload: { events: typeof events; schedules: ReturnType<typeof listSchedules>; cancelledIds: string[] } = { events, schedules: listSchedules(), cancelledIds };
        let blob = sealPostbox(armSecret, INSTANCE, payload);
        if (blob.length > MAX_BLOB) {
          // A single pathological event can outsize the count cap — drop
          // the transcript, keep the schedule truth, and say so in the mail.
          payload = {
            events: [{ type: "message", role: "user", text: "[system] postbox oversize — run transcript dropped at seal time, schedule state preserved", at: new Date().toISOString() }],
            schedules: payload.schedules,
            cancelledIds: payload.cancelledIds,
          };
          blob = sealPostbox(armSecret, INSTANCE, payload);
        }
        const ok = await postPostbox(blob);
        if (ok) app.log.info({ events: payload.events.length, bytes: blob.length, cancelled: cancelledIds.length }, "postbox posted (sealed) at autonomous sleep");
        else app.log.warn("postbox post failed — unattended output degrades to re-fire delivery");
      } catch (e) {
        app.log.warn({ err: String(e) }, "postbox post failed — unattended output degrades to re-fire delivery");
      }
    }
    // Re-arm the escrow for the NEXT due (SME review: TTL is next-due +
    // margin, so recurring schedules need a fresh arm per cycle — the
    // machine writes it right here, next to the wake rows that depend
    // on it. No schedule left → the escrow simply lapses.
    if (armSecret && backgroundTasksEnabled()) {
      const horizon = activeSchedules().reduce<number | null>((acc, s) => {
        const d = nextDueMs(s);
        return d === null ? acc : acc === null ? d : Math.min(acc, d);
      }, null);
      if (horizon !== null) {
        // The arm carries the whole machine: secret + due work + a sealed
        // snapshot (the same archive the shelf uses), so the next boot
        // wakes WITH its state — full delegation, per the opt-in. A failed
        // snapshot seals a credential without one (context-free boot, the
        // run still fires); a failed re-arm is NOT silent: the wake rows
        // above are already written, so the next boot would arrive locked
        // and the work lost — better to see it in the ring.
        let snapshot: string | undefined;
        try {
          // Context snapshot: everything but the browser profile (the
          // profile alone is tens of MiB — over any body limit — and an
          // unattended run needs log/workspace/verifier, not logins; the
          // shelf keeps serving full-profile restores when attended).
          const sealed = sealSnapshot(armSecret, INSTANCE, createArchive(true).body);
          // The concierge's /handoff takes the default body limit (1MiB) —
          // a lived-in machine's archive can outgrow it. Oversize → arm
          // context-free (the run still fires, state degrades honestly).
          const MAX_SNAP_B64 = 768 * 1024;
          if (sealed.length > MAX_SNAP_B64) {
            app.log.warn({ bytes: sealed.length, cap: MAX_SNAP_B64 }, "sleep gate: snapshot oversize — arming context-free");
          } else {
            snapshot = sealed;
            app.log.info({ bytes: snapshot.length }, "sleep gate: snapshot sealed for escrow");
          }
        } catch (e) {
          app.log.warn({ err: String(e) }, "sleep gate: snapshot seal failed — arming context-free");
        }
        const bearer = process.env.CONCIERGE_SHARED_SECRET;
        if (!bearer) {
          app.log.warn({ horizon }, "sleep-gate escrow re-arm skipped — CONCIERGE_SHARED_SECRET unset; next wake boot stays locked");
        } else {
          const ok = await armHandoff({ secret: armSecret, schedules: schedulableRows(activeSchedules()), snapshot }, bearer, horizon - Date.now() + 15 * 60_000);
          if (!ok) app.log.warn({ horizon }, "sleep-gate escrow re-arm failed — next wake boot stays locked");
        }
        // Dev file arm ONLY — two independent gates: no platform-injected
        // key (prod always has TINFOIL_API_KEY; volumes there are ephemeral
        // anyway, so the file would never be read) AND wake autonomy
        // explicitly on (the dev compose setting). A plaintext master at
        // rest is a dev-localhost trust call; prod never writes it.
        if (!process.env.TINFOIL_API_KEY && autonomyEnabled()) {
          try {
            armWakeCredential({ secret: armSecret, schedules: activeSchedules(), snapshot, inferenceKey: armInferenceKey ?? undefined });
          } catch {
            /* dev-only convenience */
          }
        }
      }
    }
  }
  setTimeout(() => process.exit(0), 500).unref();
  await app.close().catch(() => process.exit(0));
  process.exit(0);
}

// Periodic machine checkpoint while unlocked + shelved.
setInterval(() => {
  if (sleeping || !lock.unlocked || !bbGrantActive()) return;
  void pushMachineBackup()
    .then((r) => app.log.info({ pushed: r.pushed, fp: r.digest.slice(0, 12) }, "periodic backup"))
    .catch((e) => app.log.warn({ err: String(e) }, "periodic backup failed"));
}, 10 * 60_000);

setInterval(() => {
  if (sleeping || restoring || !lock.unlocked || firing) return; // a scheduled run in flight is activity
  // No client contact yet this boot: nothing to be idle FROM. A locked
  // machine (or a wake-boot whose run never started) is the concierge
  // stop row's problem, not the gate's.
  if (lastActivity === null) return;
  if (Date.now() - lastActivity > IDLE_MS) {
    void sleep(`idle ${Math.round(IDLE_MS / 1000)}s (no activity)`);
  }
}, 10_000).unref();

// The WSS event stream: token via query param (browsers cannot set WS
// headers; the channel rides the attested TLS + EHBP path).
app.get("/ws", { websocket: true }, (socket, request) => {
  const url = new URL(request.url, "http://localhost");
  if (!requireSession(request, url.searchParams.get("token") ?? undefined)) {
    socket.close(4401, "locked");
    return;
  }
  setOutcomeEmitter((outcome) => {
    if (outcome.type === "approval") {
      log?.append({ ...outcome });
      for (const peer of sockets) peer.send(JSON.stringify(outcome));
    }
  });
  const send = (
    event:
      | GatewayEvent
      | import("@waddle/sdk").DeltaEvent
      | import("@waddle/sdk").ErrorEvent
  ) => socket.send(JSON.stringify(event));
  sockets.add(socket);
  setControlNotifier((held) => {
    const evt = { type: "browser_control", held, at: new Date().toISOString() } as const;
    log?.append({ ...evt }); // the transition is history; the input never is
    for (const peer of sockets) peer.send(JSON.stringify(evt));
  });
  if (browserLive()) {
    void captureNow(); // fresh frame for the new viewer
  }
  socket.on("close", () => {
    sockets.delete(socket);
    // Mid-turn disconnect: keep logging the run (the sealed log is the truth);
    // only the live wire is gone. Deltas drop, finals and tools persist.
    setSink({
      onToolStart: (callId, tool, args) => {
        touch(); // a mid-turn disconnect still has work in flight
        log?.append({ type: "tool_start", callId, tool, args, at: new Date().toISOString() });
      },
      onToolEnd: (callId, tool, result, isError) => {
        touch();
        log?.append({ type: "tool_end", callId, tool, result, isError, at: new Date().toISOString() });
      },
      onAssistantFinal: (text) => {
        touch();
        log?.append({ type: "message", role: "assistant", text, at: new Date().toISOString() });
      },
    });
    denyAllPending(); // no client: the gate denies, the turn never hangs
  });
  touch();
  setSink({
    onDelta: (d) => {
      touch(); // streaming tokens are work too — a long turn must not be reaped
      send({ type: "delta", messageId: "live", text: d });
    },
    onToolStart: (callId, tool, args) => {
      touch();
      const evt = { type: "tool_start", callId, tool, args, at: new Date().toISOString() } as const;
      log?.append(evt);
      send(evt);
    },
    onToolEnd: (callId, tool, result, isError) => {
      touch();
      const evt = { type: "tool_end", callId, tool, result, isError, at: new Date().toISOString() } as const;
      log?.append(evt);
      send(evt);
    },
    onApprovalRequest: (req) => send(req),
    onSettled: () => send({ type: "run_settled", at: new Date().toISOString() }),
    onAssistantFinal: (text) => {
      touch();
      const evt = { type: "message", role: "assistant", text, at: new Date().toISOString() } as const;
      log?.append({ ...evt });
      send(evt);
    },
  });
  send({ type: "hello", hello: hello(VERSION, false) });
  const backlog = log?.all ?? [];
  for (const event of backlog) send(event as GatewayEvent);
  send({ type: "replay_done", count: backlog.length });

  socket.on("message", async (raw: unknown) => {
    touch();
    if (conciergeActive()) renewIdleStop(); // activity = debounce the stop row
    const intent = JSON.parse(String(raw)) as { type?: string; text?: string };
    // Restricted mode (SME review): a credential-unlocked machine serves
    // its schedules and streams state — interactive verbs refuse. The
    // user's unlock flips `autonomous` off and full mode returns.
    if (autonomous && (intent.type === "user_message" || intent.type === "browser_input" || intent.type === "browser_release")) {
      send({ type: "error", message: "machine is in autonomous mode (scheduled work only) — unlock to take over" });
      return;
    }
    if (intent.type === "sleep_now") {
      send({ type: "sleep_proposed", reason: "user requested" });
      void sleep("user requested");
      return;
    }
    if (intent.type === "approval_response") {
      const { callId, approved } = intent as { callId?: string; approved?: boolean };
      if (!callId || typeof approved !== "boolean") return;
      const tool = resolveApproval(callId, approved);
      if (tool !== null) {
        // The verdict is history: replay shows the human's decision.
        const evt = { type: "approval", callId, tool, approved, at: new Date().toISOString() } as const;
        log?.append(evt);
        send(evt);
      }
      return;
    }
    if (intent.type === "browser_input") {
      // Transient by contract: dispatched, never sealed.
      const evs = (intent as { events?: unknown[] }).events;
      if (Array.isArray(evs) && evs.length > 0 && evs.length <= 128) {
        void userInput(evs as Parameters<typeof userInput>[0]).catch((e) =>
          console.warn(`user input failed: ${e instanceof Error ? e.message : String(e)}`),
        );
      }
      return;
    }
    if (intent.type === "browser_release") {
      releaseUserControl();
      return;
    }
    if (intent.type === "preference") {
      // Threat model: the sender holds a session minted by a real unlock,
      // i.e. the master holder — delegation by them is the design (the
      // warned opt-in is UX honesty, not the security boundary; PLAN.md
      // two-tier). A stolen session token's marginal escalation (arming
      // a future escrow) is inside the documented escrow-capture residual.
      const background = (intent as { background?: unknown }).background;
      if (typeof background === "boolean") {
        try {
          const prefs = setPreferences({ background });
          app.log.info({ background: prefs.background }, "preference updated (delegation switch)");
          send({ type: "preference", background: prefs.background });
        } catch (e) {
          // A failed persistence (read-only/full disk) must never take a
          // live session down — the value stays, the client just doesn't
          // get its echo.
          app.log.warn({ err: String(e) }, "preference write failed — serving session with previous value");
        }
      }
      return;
    }
    if (intent.type === "history_restore") {
      const rows = Array.isArray((intent as { rows?: unknown }).rows)
        ? ((intent as { rows: Array<{ role?: string; text?: string }> }).rows ?? [])
        : [];
      let count = 0;
      for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const role = row.role === "user" || row.role === "assistant" || row.role === "tool" ? row.role : null;
        const text = typeof row.text === "string" ? row.text : "";
        if (!role || !text.trim()) continue;
        log?.append({ type: "history_row", role, text, at: new Date().toISOString() });
        count++;
      }
      // No broadcast: the relaying client seeds from its own copy; future
      // connections get the rows via replay from the sealed log.
      const staged = rows
        .filter((r) => r && typeof r === "object" && (r.role === "user" || r.role === "assistant" || r.role === "tool") && typeof r.text === "string" && r.text.trim())
        .map((r) => ({ role: r.role as "user" | "assistant" | "tool", text: String(r.text ?? "") }));
      if (staged.length > 0) stageHistoryRows(staged); // digest fallback if boot didn't resume natively
      send({ type: "history_restored", count });
      return;
    }
    if (intent.type === "session_restore") {
      const jsonl = (intent as { jsonl?: unknown }).jsonl;
      // Stage the pi transcript: the lazily-booted session resumes it
      // verbatim. Must precede the first chat (late relays fall back to
      // the row digest above).
      const staged = typeof jsonl === "string" && jsonl.trim().length > 0 ? stageSessionJsonl(jsonl) : false;
      send({ type: "session_restored", staged });
      return;
    }
    if (intent.type !== "user_message" || !intent.text?.trim()) return;
    if (!agentReady()) {
      send({ type: "error", message: "no inference key — reload and unlock with one" });
      return;
    }
    const userEvent = { type: "message", role: "user", text: intent.text, at: new Date().toISOString() } as const;
    log?.append({ ...userEvent });
    send(userEvent);
    try {
      await chat(intent.text); // deltas/tools/finals stream via the sink
    } catch (e) {
      send({ type: "error", message: e instanceof Error ? e.message : String(e) });
    }
  });
});

// The master secret while unlocked (two-tier autonomy: full delegation,
// per the warned background-tasks opt-in). The sleep gate seals the
// snapshot with it and re-arms the escrow; an autonomous boot inherits
// it from the credential. Memory-only, same lifetime as the lock's
// derived keys — never in DATA_DIR (the dev file arm below is the one
// documented exception, dev-only and doubly gated), never in archives.
let armSecret: string | null = null;
/** Inference key for the dev file arm (prod machines use the injected
 *  env key — this never rides the concierge escrow... except the dev file
 *  writes the same JSON; keep it out of armHandoff explicitly below). */
let armInferenceKey: string | null = null;
/** Event index at autonomous boot — the postbox carries this boot's
 *  delta (the run), not the whole restored transcript. */
let bootLogBaseline = 0;
/** Ids seeded from the wake credential — the tombstone baseline for the
 *  postbox (cancels during the run = seeded ids absent at re-sleep). */
let bootSeededIds = new Set<string>();

// Wake autonomy: a boot triggered by a concierge wake-timer finds the
// machine locked with no keys — the due work couldn't run. The credential
// comes from the concierge's memory escrow (released only to a successful
// schedule-deploy); the file arm is the dev path. A rejected or absent
// credential just leaves a normal locked boot.
//
// DELEGATED MODE (two-tier): the boot restores the snapshot and acts as
// the user — full capabilities, the same tools an attended session has.
// Interactive verbs on the wire still refuse while autonomous (a
// credential-boot is not a live user session); the user takes over by
// unlocking with their secret (matches → full mode, conversation intact).
let autonomous = false;
if (autonomyEnabled() && !lock.unlocked) {
  const cred = readWakeCredential() ?? (await pullHandoff());
  if (cred?.secret) {
    try {
      // RESTORE FIRST, then unlock. The snapshot is the whole machine as
      // it went down (workspace, sessions, master-sealed log, verifier).
      // A failed restore degrades to a context-free boot — never bricks
      // the schedule. Restoring brings back verifier.bin, so the unlock
      // below is VERIFIED (wrong/corrupted secret 401s before touching
      // anything); without a snapshot it is TOFU (deterministic verifier,
      // so the same secret re-enrolls identically either way).
      if (cred.snapshot) {
        try {
          const r = restoreArchive(openSnapshot(cred.secret as string, INSTANCE, cred.snapshot as string));
          app.log.info({ files: r.files }, "autonomous boot: snapshot restored");
        } catch (e) {
          app.log.warn({ err: String(e) }, "autonomous boot: snapshot restore failed — booting context-free");
        }
        // The restore may have brought verifier.bin in after this Lock
        // cached enrollment at module load — resync so the unlock below
        // VERIFIES against it (stale/rotated secret 401s) instead of
        // silently TOFU-enrolling whatever the credential carries.
        lock.resyncEnrollment();
      }
      const { enrolled: bootVerified } = lock.unlock(cred.secret as string, freshNonce());
      // Evidence in the sealed log itself: a snapshot restore + successful
      // unlock = the credential's secret VERIFIED against the restored
      // verifier (a wrong one would have thrown); no snapshot = TOFU.
      const bootMode = cred.snapshot ? "state restored, verified unlock" : "context-free boot (TOFU unlock)";
      app.log.info({ verified: bootVerified, hadSnapshot: !!cred.snapshot }, "autonomous boot: unlock result");
      log = new EventLog(lock.logKey, lock.storage);
      bootLogBaseline = log.all.length;
      // Seed the due work: every deploy is a fresh volume, so the schedule
      // table travels inside the credential. Seeded ids are captured —
      // the postbox diff (seeded minus surviving) is the cancel tombstone
      // set at re-sleep.
      if (cred.schedules) {
        seedSchedules(cred.schedules as Schedule[]);
        bootSeededIds = new Set((cred.schedules as Schedule[]).map((r) => r.id));
      }
      if (cred.inferenceKey) {
        initAgent(cred.inferenceKey as string); // dev file arm only
        armInferenceKey = cred.inferenceKey as string;
      }
      autonomous = true;
      armSecret = cred.secret as string;
      // The credential IS the opt-in evidence: the sleep gate arms only
      // when the background preference is on. A CONTEXT-FREE boot (no
      // snapshot — oversize degrade or seal failure) has no
      // preferences.json to inherit, and would otherwise read background
      // off, skip its own re-arm, and break the recurring chain. Re-assert
      // the preference from the credential's authority.
      if (!backgroundTasksEnabled()) {
        try {
          setPreferences({ background: true });
          app.log.info("autonomous boot: background preference re-asserted (context-free boot had none)");
        } catch (e) {
          app.log.warn({ err: String(e) }, "autonomous boot: preference re-assert failed — re-arm may skip");
        }
      }
      log.append({ type: "message", role: "user", text: `[system] autonomous boot — ${bootMode}, acting as user (background tasks)`, at: new Date().toISOString() });
      app.log.info({ restored: !!cred.snapshot }, "autonomous boot: unlocked from wake credential (delegated mode)");
      // Shared-secret handshake (the escrow no longer carries a bearer):
      // without a session the machine cannot idle-stop, and burns forever.
      if (process.env.CONCIERGE_SHARED_SECRET) {
        await handshakeConcierge(process.env.CONCIERGE_SHARED_SECRET).catch(() => undefined);
      }
      if (conciergeActive()) {
        renewIdleStop();
        app.log.info({ via: "shared-secret" }, "autonomous concierge handshake");
      }
    } catch (e) {
      clearWakeCredential();
      app.log.warn({ err: String(e) }, "wake credential rejected — cleared, booting locked");
    }
  }
}

// A boot that stays locked (wake row fired, but no credential survived the
// fresh volume — or nobody came) must not burn compute forever: handshake
// with the shared secret already in env and arm the stop backstop, so the
// concierge reaps it one idle-window after boot. Unlock renews past it; a
// user arriving late just triggers the normal wake path again.
// (No conciergeActive() here — that reads the session token, which a locked
// boot cannot have yet. The env presence IS the wiring check.)
if (!lock.unlocked && process.env.CONCIERGE_SHARED_SECRET && process.env.CONCIERGE_URL) {
  void handshakeConcierge(process.env.CONCIERGE_SHARED_SECRET).then((ok) => {
    if (ok) {
      renewIdleStop();
      app.log.info("locked boot: stop backstop armed — reaped if nobody unlocks");
    }
  });
}

await app.listen({ port: PORT, host: "0.0.0.0" });
