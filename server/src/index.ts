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
import { Lock } from "./state.js";
import { EventLog } from "./log.js";
import { initAgent, chat, agentReady, stageSessionJsonl, stageHistoryRows, setBlackbox, setSink, getSessionJsonl } from "./agent.js";
import { resolveApproval, denyAllPending, setOutcomeEmitter } from "./approvals.js";
import { setBrowserEvents, browserLive, captureNow, userInput, releaseUserControl, setControlNotifier, stopBrowser } from "./browser.js";
// (createArchive/restoreArchive live behind bb-backup.ts now; the old
// debug GET /archive is gone — machine bytes never travel unsealed)
import { setBbGrant, clearBbGrant, bbGrantActive, pushMachineBackup, pullMachineBackup, pruneOldGens } from "./bb-backup.js";

/** Reject after ms — bounds restore/final-backup so nothing hangs the boot or the exit. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

const PORT = Number(process.env.PORT ?? 8080);
const VERSION = "0.0.1";

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
  const { secret, nonce, inferenceKey, bb } = (request.body ?? {}) as UnlockRequest & {
    inferenceKey?: string;
    bb?: import("./bb-backup.js").BbGrant;
  };
  if (!secret || !nonce) return reply.code(400).send({ error: "secret and nonce required" });
  try {
    const { token, enrolled } = lock.unlock(secret, nonce);
    if (!log) log = new EventLog(lock.logKey, lock.storage);
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
    // The inference key rides the same attested, EHBP-encrypted unlock —
    // memory-only, never on disk, never in config. The agent boots lazily
    // on first use; a persisted pi session file (same scratch as this log)
    // is resumed natively at boot — no digest needed on this path.
    if (inferenceKey) initAgent(inferenceKey);
    const res: UnlockResponse = { token, enrolled };
    return res;
  } catch (e) {
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
// Unlocked + zero attached clients + idle past the gate → checkpoint (the
// log is already sealed per-event) → broadcast → graceful exit. The
// platform's restart policy is `no` (config default), so the instance
// stops — and billing with it. The concierge wakes it.
const IDLE_MS = Number(process.env.WADDLE_IDLE_MS ?? 120_000);
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
let lastActivity = Date.now();
let sleeping = false;

async function sleep(reason: string): Promise<never> {
  if (sleeping) await new Promise(() => {}); // already going down
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
  if (sleeping || !lock.unlocked) return;
  if (sockets.size === 0 && Date.now() - lastActivity > IDLE_MS) {
    void sleep(`idle ${Math.round(IDLE_MS / 1000)}s with no clients`);
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
        log?.append({ type: "tool_start", callId, tool, args, at: new Date().toISOString() });
      },
      onToolEnd: (callId, tool, result, isError) => {
        log?.append({ type: "tool_end", callId, tool, result, isError, at: new Date().toISOString() });
      },
      onAssistantFinal: (text) => {
        log?.append({ type: "message", role: "assistant", text, at: new Date().toISOString() });
      },
    });
    denyAllPending(); // no client: the gate denies, the turn never hangs
  });
  lastActivity = Date.now();
  setSink({
    onDelta: (d) => send({ type: "delta", messageId: "live", text: d }),
    onToolStart: (callId, tool, args) => {
      const evt = { type: "tool_start", callId, tool, args, at: new Date().toISOString() } as const;
      log?.append(evt);
      send(evt);
    },
    onToolEnd: (callId, tool, result, isError) => {
      const evt = { type: "tool_end", callId, tool, result, isError, at: new Date().toISOString() } as const;
      log?.append(evt);
      send(evt);
    },
    onApprovalRequest: (req) => send(req),
    onSettled: () => send({ type: "run_settled", at: new Date().toISOString() }),
    onAssistantFinal: (text) => {
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
    lastActivity = Date.now();
    const intent = JSON.parse(String(raw)) as { type?: string; text?: string };
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

await app.listen({ port: PORT, host: "0.0.0.0" });
