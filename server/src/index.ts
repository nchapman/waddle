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
import { initAgent, chat, agentReady, setBlackbox } from "./agent.js";

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

// The WSS event stream: token via query param (browsers cannot set WS
// headers; the channel rides the attested TLS + EHBP path).
app.get("/ws", { websocket: true }, (socket, request) => {
  const url = new URL(request.url, "http://localhost");
  if (!requireSession(request, url.searchParams.get("token") ?? undefined)) {
    socket.close(4401, "locked");
    return;
  }
  const send = (event: GatewayEvent | import("@waddle/sdk").DeltaEvent | import("@waddle/sdk").ErrorEvent) =>
    socket.send(JSON.stringify(event));
  send({ type: "hello", hello: hello(VERSION, false) });
  for (const event of log?.all ?? []) send(event as GatewayEvent);

  socket.on("message", async (raw: unknown) => {
    const intent = JSON.parse(String(raw)) as UserIntent;
    if (intent.type !== "user_message" || !intent.text?.trim()) return;
    if (!agentReady()) {
      send({ type: "error", message: "no inference key — reload and unlock with one" });
      return;
    }
    if (streaming) {
      send({ type: "error", message: "one turn at a time (First Light)" });
      return;
    }
    streaming = true;
    const userEvent = { type: "message", role: "user", text: intent.text } as const;
    log?.append({ ...userEvent, at: new Date().toISOString() });
    send(userEvent);
    const messageId = randomUUID();
    try {
      const text = await chat(intent.text, (delta) => send({ type: "delta", messageId, text: delta }));
      const assistantEvent = { type: "message", role: "assistant", text, at: new Date().toISOString() } as const;
      log?.append({ ...assistantEvent });
      send(assistantEvent);
    } catch (e) {
      send({ type: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      streaming = false;
    }
  });
});

await app.listen({ port: PORT, host: "0.0.0.0" });
