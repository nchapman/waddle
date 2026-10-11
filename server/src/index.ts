/**
 * Waddle server — production entry. The gateway itself (routes, sleep
 * gate, wake boot, ws intent routing) is built in app.ts's buildApp() so
 * tests can drive the real routes in-process; this file runs the boot
 * sequence, listens, and serves the websocket upgrade path.
 */
import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import { WebSocketServer } from "ws";
import { buildApp } from "./app.js";
import { registerBootSecrets } from "./guard/policy.js";

// The platform secrets are the gateway's alone: register them for output
// redaction before anything else runs (children never see them — their env
// is scrubbed at spawn — but tool results get scrubbed as belt-and-braces).
registerBootSecrets();

const PORT = Number(process.env.PORT ?? 8080);

const { app, wakeBoot, setServer } = buildApp();
await wakeBoot(); // autonomous boot when the wake credential is armed; no-op otherwise

const server = serve(
  {
    fetch: app.fetch,
    port: PORT,
    hostname: "0.0.0.0",
    // The WSS upgrade path — noServer: the adapter hands upgrades to it
    // after the /ws route's upgradeWebSocket handler claims the request.
    websocket: { server: new WebSocketServer({ noServer: true }) },
  },
  (info) => console.log(`[waddle] listening on ${info.address}:${info.port}`),
);
setServer(server as Server);
