/**
 * Multi-client wiring: several browsers on ONE machine. The turn stream
 * (the agent sink) must fan out to every authenticated socket — not just
 * the newest connection — and closing one client must never quiet the
 * stream or deny approvals while another still watches. The sink is driven
 * directly (the seam buildApp exposes); the live two-client model-turn
 * proof runs against the deployed stack via scripts/platform-probe.mjs.
 *
 * Run: node --import tsx --test src/ws-multi.test.ts
 */
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";

const DATA_DIR = mkdtempSync(join(tmpdir(), "waddle-ws-multi-"));
process.env.DATA_DIR = DATA_DIR;
delete process.env.TINFOIL_API_KEY;
delete process.env.CONCIERGE_URL;
delete process.env.CONCIERGE_SHARED_SECRET;

const { buildApp } = await import("./app.js");
const { requestApproval, setApprovalEmitter } = await import("./approvals.js");

const srv = buildApp();
const { app, agentSink, fireSchedule } = srv;

const SECRET = randomBytes(64).toString("base64");
const post = (path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

// Two unlocks, same secret, distinct nonces → two valid session tokens:
// the second device's unlock mints its own session and leaves the first's
// alive (state.ts keeps a token Map; nothing invalidates on re-unlock).
async function unlockDevice(): Promise<string> {
  const res = await post("/unlock", { secret: SECRET, nonce: randomBytes(16).toString("base64") });
  assert.equal(res.status, 200, `unlock failed: ${res.status}`);
  const body = (await res.json()) as { token: string };
  assert.ok(body.token, "unlock must mint a session token");
  return body.token;
}

type Frame = { type: string; [k: string]: unknown };
/** A connected client: collects frames until the predicate matches. */
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
  const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
  const waitFor = (ok: (f: Frame) => boolean, label: string, ms = 5000): Promise<void> =>
    new Promise((resolve, reject) => {
      if (frames.some(ok)) return resolve();
      const t = setTimeout(
        () => reject(new Error(`timeout waiting for ${label}; saw ${frames.map((f) => f.type).join(",")}`)),
        ms,
      );
      waiters.push({ ok, settle: () => { clearTimeout(t); resolve(); } });
    });
  return { ws, frames, opened, closed, waitFor, close() { ws.close(); } };
}

// import ws lazily like app.test.ts does, after env is in place
const trace = (m: string) => console.error(`[multi] ${m}`);
const { serve } = await import("@hono/node-server");
const { WebSocketServer, WebSocket: Ws } = await import("ws");

test("two clients on one machine: the turn fans out, one closing never kills the stream", async () => {
  const clients: Array<ReturnType<typeof client>> = [];
  let server: ReturnType<typeof serve> | null = null;
  try {
  const [tokenA, tokenB] = [await unlockDevice(), await unlockDevice()];
  assert.notEqual(tokenA, tokenB, "each device mints its own session");

  server = serve({
    fetch: app.fetch,
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

    const a = client(port, tokenA);
    const b = client(port, tokenB);
    clients.push(a, b);
    trace("sockets up");
    await Promise.all([a.opened, b.opened]);
    await Promise.all([
      a.waitFor((f) => f.type === "replay_done", "A replay"),
      b.waitFor((f) => f.type === "replay_done", "B replay"),
    ]);

    // A model turn, driven through the agent sink: deltas, tools, the final.
    agentSink.onDelta?.("hello ");
    agentSink.onDelta?.("world");
    agentSink.onToolStart?.("c1", "read", { path: "/tmp/x" });
    agentSink.onToolEnd?.("c1", "read", "contents", false);
    agentSink.onAssistantFinal?.("hello world");
    agentSink.onSettled?.();

    const watchers: Array<[string, ReturnType<typeof client>]> = [["A", a], ["B", b]];
    for (const [name, c] of watchers) {
      trace(`waiting ${name} final`);
      await c.waitFor((f: Frame) => f.type === "message" && f.role === "assistant" && f.text === "hello world", `${name} final`);
      const types = c.frames.map((f: Frame) => f.type);
      assert.ok(types.includes("delta"), `${name} must see deltas`);
      assert.ok(types.filter((t: string) => t === "tool_start").length === 1, `${name} must see the tool`);
      assert.ok(types.includes("run_settled"), `${name} must see settle`);
    }
    assert.deepEqual(
      a.frames.filter((f) => f.type !== "hello" && f.type !== "replay_done").map((f) => f.type),
      b.frames.filter((f) => f.type !== "hello" && f.type !== "replay_done").map((f) => f.type),
      "both clients see the identical stream",
    );

    // A late joiner gets the sealed history via replay (the second browser
    // opened mid-conversation).
    trace("late joiner");
    const c3 = client(port, await unlockDevice());
    clients.push(c3);
    await c3.opened;
    trace("late joiner opened, waiting replay");
    await c3.waitFor((f) => f.type === "replay_done", "C replay");
    assert.ok(
      c3.frames.some((f) => f.type === "message" && f.role === "assistant" && f.text === "hello world"),
      "the late joiner's replay carries the assistant final",
    );
    c3.close();

    // B closes. A must keep streaming — the sharpest single-client bug
    // (onClose used to quiet the sink and deny pending approvals on ANY
    // close, sockets.size be damned).
    b.close();
    await b.closed;
    trace("B closed; streaming on");
    agentSink.onDelta?.("still ");
    agentSink.onAssistantFinal?.("still here");
    await a.waitFor((f) => f.type === "message" && f.role === "assistant" && f.text === "still here", "A survives B's close");

    // The approval ask reaches every client through the REAL ask path
    // (requestApproval drives the ask); ANY client may answer it. The
    // emitter wiring is agent-boot's job in production — mirrored here so
    // the ask rides the same sink the turn does.
    setApprovalEmitter((req) => {
      if (req.type === "approval_request") agentSink.onApprovalRequest?.(req);
    });
    const verdict = requestApproval("c2", "browser_open", { url: "https://x.example" });
    await a.waitFor((f) => f.type === "approval_request" && f.callId === "c2", "A sees the approval ask");
    a.ws.send(JSON.stringify({ type: "approval_response", callId: "c2", approved: true }));
    await a.waitFor((f) => f.type === "approval" && f.callId === "c2" && f.approved === true, "A sees its own verdict");
    assert.equal(await verdict, true, "the answering client's verdict resolves the ask");

    // A leaves last: the quiet path takes over (no crash, nothing hangs).
    a.close();
    await a.closed;
    agentSink.onDelta?.("nobody");
    agentSink.onAssistantFinal?.("sealed but unseen");
    assert.ok(true, "quiet sink path did not throw");
  } finally {
    for (const c of clients) { try { c.ws.terminate(); } catch { /* already gone */ } }
    await new Promise<void>((resolve) => {
      if (!server) return resolve();
      server.close(() => resolve());
      (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.(); // never wedge the runner
    });
  }
});
