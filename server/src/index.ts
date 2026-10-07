/**
 * Waddle server — a single-user app in a secure container.
 * Lock screen: /health + /unlock exist pre-unlock; everything else is
 * gated on the session credential derived from the unlock transcript.
 */
import fastify from "fastify";
import websocket from "@fastify/websocket";
import cors from "@fastify/cors";
import { randomUUID } from "node:crypto";
import { hello, type GatewayEvent, type UnlockRequest, type UnlockResponse, type StateResponse } from "@waddle/sdk";
import { Lock } from "./state.js";
import { EventLog } from "./log.js";

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

function requireSession(request: { headers: Record<string, unknown> }, token?: string): boolean {
  const auth = request.headers.authorization;
  const bearer = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : token;
  return lock.verify(bearer);
}

app.get("/health", async () => hello(VERSION, !lock.unlocked, lock.storage));

app.post("/unlock", async (request, reply) => {
  const { secret, nonce } = (request.body ?? {}) as UnlockRequest;
  if (!secret || !nonce) return reply.code(400).send({ error: "secret and nonce required" });
  try {
    const { token, enrolled } = lock.unlock(secret, nonce);
    if (!log) log = new EventLog(lock.logKey, lock.storage);
    const res: UnlockResponse = { token, enrolled };
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

// The WSS event stream: token via query param (browsers cannot set WS
// headers; the channel rides the attested TLS + EHBP path).
app.get("/ws", { websocket: true }, (socket, request) => {
  const url = new URL(request.url, "http://localhost");
  if (!requireSession(request, url.searchParams.get("token") ?? undefined)) {
    socket.close(4401, "locked");
    return;
  }
  const send = (event: GatewayEvent) => socket.send(JSON.stringify(event));
  send({ type: "hello", hello: hello(VERSION, false) });
  for (const event of log?.all ?? []) send(event as GatewayEvent);
  socket.on("message", (raw: unknown) => {
    const intent = JSON.parse(String(raw));
    log?.append({ id: randomUUID(), at: new Date().toISOString(), intent });
    send({ type: "message", eventId: randomUUID(), role: "user", text: String((intent as { text?: string }).text ?? "") });
  });
});

await app.listen({ port: PORT, host: "0.0.0.0" });
