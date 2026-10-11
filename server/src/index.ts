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
import { DATA_DIR, registerBootSecrets } from "./guard/policy.js";
import { enforcePlaypen } from "./guard/playpen.js";

// The platform secrets are the gateway's alone: register them for output
// redaction before anything else runs (children never see them — their env
// is scrubbed at spawn — but tool results get scrubbed as belt-and-braces).
registerBootSecrets();
// The playpen's file half: everything the root gateway creates is private
// to root by default (the sealed log, verifier, schedules, sessions).
process.umask(0o077);
// Scratch lives on the writable volume, never /tmp (the enclave mounts it
// read-only — a truncated-output spool or restore slot would EROFS). bash
// children inherit this through the env allowlist; the browser sets its own.
if (!process.env.TMPDIR) process.env.TMPDIR = `${DATA_DIR}/tmp`;

const PORT = Number(process.env.PORT ?? 8080);

const { app, wakeBoot, setServer } = buildApp();
await wakeBoot(); // autonomous boot when the wake credential is armed; no-op otherwise
enforcePlaypen(); // idempotent; restores re-enforce inside restoreArchive

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
