/**
 * @waddle/concierge — production entry. The service (routes, table, pool,
 * scans) is built in app.ts's buildApp() so tests can drive the real
 * routes in-process with an injected Platform; this file only listens.
 */
import { serve } from "@hono/node-server";
import { buildApp } from "./app.js";

const PORT = Number(process.env.CONCIERGE_PORT ?? 8081);

const { app } = buildApp();
serve({ fetch: app.fetch, port: PORT, hostname: "0.0.0.0" }, (info) =>
  console.log(`[concierge] listening on ${info.address}:${info.port}`),
);
