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
import { initAgent, chat, agentReady, setBlackbox, setSink } from "./agent.js";
import { resolveApproval, denyAllPending, setOutcomeEmitter } from "./approvals.js";

const PORT = Number(process.env.PORT ?? 8080);
const VERSION = "0.0.1";

const app = fastify({ logger: true });
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

app.post("/unlock", async (request, reply) => {
  const { secret, nonce, inferenceKey } = (request.body ?? {}) as UnlockRequest & { inferenceKey?: string };
  if (!secret || !nonce) return reply.code(400).send({ error: "secret and nonce required" });
  try {
    const { token, enrolled } = lock.unlock(secret, nonce);
    if (!log) log = new EventLog(lock.logKey, lock.storage);
    // The inference key rides the same attested, EHBP-encrypted unlock —
    // memory-only, never on disk, never in config.
    if (inferenceKey) initAgent(inferenceKey);    const res: UnlockResponse = { token, enrolled };
    return res;
  } catch (e) {
    const err = e as { statusCode?: number; message: string };
    return reply.code(err.statusCode ?? 500).send({ error: err.message });
  }
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
  setTimeout(() => process.exit(0), 500).unref();
  await app.close().catch(() => process.exit(0));
  process.exit(0);
}

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
  socket.on("close", () => {
    sockets.delete(socket);
    // Mid-turn disconnect: keep logging the run (the sealed log is the truth);
    // only the live wire is gone. Deltas drop, finals and tools persist.
    void setSink({
      onToolStart: (callId, tool, args) => {
        log?.append({ type: "tool_start", callId, tool, args, at: new Date().toISOString() });
      },
      onToolEnd: (callId, tool, result, isError) => {
        log?.append({ type: "tool_end", callId, tool, result, isError, at: new Date().toISOString() });
      },
      onAssistantFinal: (text) => {
        log?.append({ type: "message", role: "assistant", text, at: new Date().toISOString() });
      },
    }).catch(() => undefined);
    denyAllPending(); // no client: the gate denies, the turn never hangs
  });
  lastActivity = Date.now();
  void setSink({
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
  }).catch((e) => send({ type: "error", message: `sink: ${e instanceof Error ? e.message : String(e)}` }));
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
      send({ type: "history_restored", count });
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
