/**
 * Scheduled-fire broadcast: the injected prompt reaches every connected
 * client as a user row (the thread renders it collapsed), the reply and —
 * when the run dies — the failure row follow as assistant rows. Own file
 * on purpose: DATA_DIR and the env are module-load constants, so real
 * isolation means a fresh module graph, not a second buildApp over the
 * same disk log.
 *
 * Run: node --import tsx --test src/ws-fire.test.ts
 */
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";

const DATA_DIR = mkdtempSync(join(tmpdir(), "waddle-ws-fire-"));
process.env.DATA_DIR = DATA_DIR;
delete process.env.TINFOIL_API_KEY;
delete process.env.CONCIERGE_URL;
delete process.env.CONCIERGE_SHARED_SECRET;

const { buildApp } = await import("./app.js");

const srv = buildApp();
const SECRET = randomBytes(64).toString("base64");

type Frame = { type: string; [k: string]: unknown };
/** A connected idle watcher: collects frames until a predicate matches. */
function client(port: number, token: string) {
  const frames: Frame[] = [];
  const waiters: Array<{ ok: (f: Frame) => boolean; settle: () => void }> = [];
  const ws = new Ws(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
  const opened = new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("connect timeout")), 5000);
    ws.once("open", () => { clearTimeout(t); resolve(); });
  });
  ws.on("message", (raw: unknown) => {
    const f = JSON.parse(String(raw)) as Frame;
    frames.push(f);
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i]!;
      if (w.ok(f)) { w.settle(); waiters.splice(i, 1); }
    }
  });
  const waitFor = (ok: (f: Frame) => boolean, label: string, ms = 5000): Promise<void> =>
    new Promise((resolve, reject) => {
      if (frames.some(ok)) return resolve();
      const t = setTimeout(
        () => reject(new Error(`timeout waiting for ${label}; saw ${frames.map((f) => f.type).join(",")}`)),
        ms,
      );
      waiters.push({ ok, settle: () => { clearTimeout(t); resolve(); } });
    });
  return { ws, frames, opened, waitFor };
}

const { serve } = await import("@hono/node-server");
const { WebSocketServer, WebSocket: Ws } = await import("ws");

test("a scheduled fire reaches connected clients: injected prompt, and the failure row when the run dies", async () => {
  const res = await srv.app.request("/unlock", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: SECRET, nonce: randomBytes(16).toString("base64") }),
  });
  assert.equal(res.status, 200, "unlock failed");
  const { token } = (await res.json()) as { token: string };

  let server: ReturnType<typeof serve> | null = null;
  let watcher: ReturnType<typeof client> | null = null;
  try {
    server = serve({
      fetch: srv.app.fetch,
      port: 0,
      hostname: "127.0.0.1",
      websocket: { server: new WebSocketServer({ noServer: true }) },
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("listening", resolve);
      server!.once("error", reject);
      setTimeout(() => reject(new Error("server never listened")), 5000).unref();
    });
    const port = (server!.address() as { port: number }).port;

    watcher = client(port, token);
    await watcher.opened;
    await watcher.waitFor((f) => f.type === "replay_done", "replay");

    // The seam drives fireSchedule directly. The prompt broadcast is
    // synchronous; the run itself has no model key here and dies fast —
    // which is the second thing under test.
    void srv.fireSchedule({
      id: "t1",
      title: "Call mom",
      prompt: "Remind the user to call their mom.",
      at: new Date().toISOString(),
      enabled: true,
      createdAt: new Date().toISOString(),
    });

    await watcher.waitFor(
      (f) => f.type === "message" && f.role === "user" && String(f.text).startsWith("[scheduled: Call mom]"),
      "the injected prompt broadcasts",
    );
    await watcher.waitFor(
      (f) => f.type === "message" && f.role === "assistant" && String(f.text).startsWith("scheduled run failed:"),
      "a dead run broadcasts its failure row (idle collectors flush on it)",
    );
  } finally {
    // Terminate before closing the server — an open client keeps the
    // server from finishing its close and can wedge the runner.
    watcher?.ws.terminate();
    server?.close();
    (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
  }
});
