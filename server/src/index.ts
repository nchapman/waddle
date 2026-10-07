/**
 * Waddle VM — a single-user app in a secure container.
 * Scaffold: health + a stub WSS endpoint. Phase 1 builds the real
 * gateway (attested WSS, unlock lock-screen, event log replay).
 */
import fastify from "fastify";
import websocket from "@fastify/websocket";
import { hello, type GatewayEvent } from "@waddle/sdk";

const PORT = Number(process.env.PORT ?? 8080);
const VERSION = "0.0.1";

const app = fastify({ logger: true });
await app.register(websocket);

app.get("/health", async () => hello(VERSION));

app.get("/ws", { websocket: true }, (socket) => {
  const send = (event: GatewayEvent) => socket.send(JSON.stringify(event));
  send({ type: "hello", hello: hello(VERSION) });
  // Phase 1: replay the event log from the client's cursor, then stream
  // live. Inbound messages are intents only — never history.
  socket.on("message", (raw: unknown) => {
    app.log.debug({ raw: String(raw) }, "intent received (Phase 1)");
  });
});

await app.listen({ port: PORT, host: "0.0.0.0" });
