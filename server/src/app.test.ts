/**
 * Route-level tests for the Hono gateway — the lock screen, the unlock
 * contract, session-gated reads, the ws intent router (socket-free), and
 * the wake-boot sequence. One process, one DATA_DIR; the shared-Lock
 * tests run in a deliberate order (one real unlock up front — the
 * attempt window is small — and the rate-limit burn last).
 */
import { test } from "node:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";

const DATA_DIR = mkdtempSync(join(tmpdir(), "waddle-app-"));
process.env.DATA_DIR = DATA_DIR;
delete process.env.TINFOIL_API_KEY; // no agent in tests — keeps /session honest
delete process.env.CONCIERGE_URL; // no concierge leg on the plain unlock path
delete process.env.CONCIERGE_SHARED_SECRET;

const { buildApp } = await import("./app.js");
const { listSchedules } = await import("./schedules.js");
const { getPreferences } = await import("./preferences.js");
const { armWakeCredential } = await import("./wakeboot.js");

const srv = buildApp();
const { app, handleIntent } = srv;

const SECRET_A = randomBytes(64).toString("base64");
const SECRET_B = randomBytes(64).toString("base64");
const post = (path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const collector = () => {
  const sent: Array<Record<string, unknown>> = [];
  return { sent, send: (e: Record<string, unknown>) => void sent.push(e) };
};
let token = ""; // the one real unlock's session — reused (the attempt window is small)

test("lock screen: /health answers pre-unlock with the platform shape", async () => {
  const res = await app.request("/health");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.service, "waddle-server");
  assert.equal(body.locked, true);
  assert.equal(body.storage, "disk");
  assert.equal(typeof body.hostname, "string");
  assert.equal(typeof body.version, "string");
  // The kernel-boundary state is part of the contract: dev hosts degrade
  // honestly (enforced:false), the container must say what it achieved.
  assert.ok(body.playpen && typeof body.playpen.enforced === "boolean");
  assert.ok(body.playpen.reason === undefined || typeof body.playpen.reason === "string");
});

test("/probe reports platform facts without touching user data", async () => {
  const body = await (await app.request("/probe")).json();
  assert.equal(typeof body.uid, "number");
  assert.match(body.capEff, /^0x/);
  assert.equal(body.dataDirWritable, "disk");
  assert.equal(body.node, process.version);
});

test("unlock: missing secret/nonce is a 400", async () => {
  const res = await post("/unlock", { secret: SECRET_A });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "secret and nonce required");
});

test("unlock: malformed JSON body is a 400", async () => {
  const res = await post("/unlock", "{not json");
  assert.equal(res.status, 400);
});

test("unlock: fresh volume TOFU-enrolls and mints a session token (reused below)", async () => {
  const res = await post("/unlock", { secret: SECRET_A, nonce: randomBytes(16).toString("base64") });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(typeof body.token, "string");
  assert.ok(body.token.length > 20);
  assert.equal(body.enrolled, true);
  assert.equal(body.background, false);
  token = body.token;
});

test("session-gated reads refuse without the bearer, serve with it", async () => {
  assert.equal((await app.request("/state")).status, 401);
  assert.equal((await app.request("/state", { headers: { authorization: "Bearer nope" } })).status, 401);
  const res = await app.request("/state", { headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.unlocked, true);
  assert.equal(body.enrolled, true);
  assert.deepEqual(body.events, []);
});

test("/debug/log serves the (redacted) request ring to the session", async () => {
  assert.equal((await app.request("/debug/log")).status, 401);
  const body = await (await app.request("/debug/log", { headers: { authorization: `Bearer ${token}` } })).json();
  assert.ok(Array.isArray(body.lines));
  assert.ok(body.lines.length > 0);
});

test("/session reports the missing inference key instead of booting an agent", async () => {
  const res = await app.request("/session", { headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.match(body.error, /inference key/);
});

test("unknown routes 404 with a JSON body", async () => {
  const res = await app.request("/nope");
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, "not found");
});

// ── The ws intent router (socket-free) ───────────────────────────────────

test("preference intent persists the delegation switch and echoes it", async () => {
  const { sent, send } = collector();
  await handleIntent(send as never, JSON.stringify({ type: "preference", background: true }));
  assert.deepEqual(sent.map((e) => e.type), ["preference"]);
  assert.equal(sent[0]?.background, true);
  assert.equal(getPreferences().background, true); // persisted for the next unlock response
});

test("history_restore seals valid rows, drops invalid ones, reports the count", async () => {
  const { sent, send } = collector();
  await handleIntent(
    send as never,
    JSON.stringify({
      type: "history_restore",
      rows: [
        { role: "user", text: "hello" },
        { role: "assistant", text: "hi there" },
        { role: "bogus", text: "dropped" },
        { role: "user", text: "   " },
      ],
    }),
  );
  assert.deepEqual(sent.map((e) => e.type), ["history_restored"]);
  assert.equal(sent[0]?.count, 2);
  const res = await app.request("/state", { headers: { authorization: `Bearer ${token}` } });
  const state2 = await res.json();
  const rows = state2.events.filter((e: { type: string }) => e.type === "history_row");
  assert.equal(rows.length, 2); // the invalid rows never entered the sealed log
});

test("session_restore stages the pi transcript for the lazy boot", async () => {
  const { sent, send } = collector();
  await handleIntent(send as never, JSON.stringify({ type: "session_restore", jsonl: '{"type":"user","text":"x"}\n' }));
  assert.deepEqual(sent.map((e) => e.type), ["session_restored"]);
  assert.equal(sent[0]?.staged, true);
});

test("browser_input over the 128-event cap is dropped without spawning Chromium", async () => {
  const { sent, send } = collector();
  const events = Array.from({ length: 129 }, () => ({ type: "key", key: "a" }));
  await handleIntent(send as never, JSON.stringify({ type: "browser_input", events }));
  assert.equal(sent.length, 0); // transient by contract — no reply, no dispatch
});

test("user_message without an inference key errors honestly", async () => {
  const { sent, send } = collector();
  await handleIntent(send as never, JSON.stringify({ type: "user_message", text: "hi" }));
  assert.deepEqual(sent.map((e) => e.type), ["error"]);
  assert.match(String(sent[0]?.message), /no inference key/);
});

test("a non-JSON frame rejects (the socket path relies on crash logging)", async () => {
  const { send } = collector();
  await assert.rejects(() => handleIntent(send as never, "{not json"));
});

// ── Rate limiting (runs late: it burns the shared Lock's attempt budget) ──

test("wrong secret 401s, then the attempt window rate-limits (429)", async () => {
  for (let i = 0; i < 4; i++) {
    const res = await post("/unlock", { secret: SECRET_B, nonce: randomBytes(16).toString("base64") });
    assert.equal(res.status, 401, `attempt ${i}`);
  }
  const limited = await post("/unlock", { secret: SECRET_A, nonce: randomBytes(16).toString("base64") });
  assert.equal(limited.status, 429);
});

// ── The production ws wiring (real socket through the node adapter) ──────

test("the /ws wiring upgrades and streams — and a locked socket closes 4401", async () => {
  const { serve } = await import("@hono/node-server");
  const { WebSocketServer, WebSocket: Ws } = await import("ws");
  const server = serve({
    fetch: app.fetch,
    port: 0,
    hostname: "127.0.0.1",
    websocket: { server: new WebSocketServer({ noServer: true }) }, // the entry's exact wiring
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
      setTimeout(() => reject(new Error("server never listened")), 5000).unref();
    });
    const addr = server.address();
    if (addr === null || typeof addr === "string") throw new Error("no port");
    const port = addr.port;
    // Good token: the upgrade lands, hello + backlog + replay_done stream.
    await new Promise<void>((resolve, reject) => {
      const ws = new Ws(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
      const types: string[] = [];
      ws.on("message", (raw: unknown) => {
        types.push(JSON.parse(String(raw)).type);
        if (types.at(-1) === "replay_done") {
          assert.equal(types[0], "hello");
          ws.close();
          resolve();
        }
      });
      ws.on("error", reject);
      setTimeout(() => reject(new Error("timeout: " + types.join(","))), 5000).unref();
    });
    // Bad token: closed 4401 before any frame lands.
    const closed = await new Promise<number>((resolve, reject) => {
      const ws = new Ws(`ws://127.0.0.1:${port}/ws?token=wrong`);
      ws.on("close", (code: number) => resolve(code));
      ws.on("error", reject);
      setTimeout(() => reject(new Error("no close")), 5000).unref();
    });
    assert.equal(closed, 4401);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// ── Wake boot (fresh buildApps — each carries its own Lock) ──────────────

test("wakeBoot: an armed credential unlocks into restricted autonomous mode", async () => {
  process.env.WADDLE_WAKE_AUTONOMY = "1";
  const iso = new Date().toISOString();
  armWakeCredential({
    secret: SECRET_A,
    schedules: [{ id: "wake-1", title: "t", prompt: "p", enabled: true, createdAt: iso, at: new Date(Date.now() + 3600_000).toISOString() }],
  });
  const srv2 = buildApp();
  await srv2.wakeBoot();
  // Unlocked, autonomous, seeded — and interactive verbs refuse.
  const health = await (await srv2.app.request("/health")).json();
  assert.equal(health.locked, false);
  assert.ok(listSchedules().some((s) => s.id === "wake-1"));
  const { sent, send } = collector();
  await srv2.handleIntent(send as never, JSON.stringify({ type: "user_message", text: "hi" }));
  assert.match(String(sent[0]?.message), /autonomous mode/);
  // Takeover: a real unlock with the same secret lifts the restriction.
  const unlock = await srv2.app.request("/unlock", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: SECRET_A, nonce: randomBytes(16).toString("base64") }),
  });
  assert.equal(unlock.status, 200);
  // Takeover consumes the wake credential (wakeboot's documented
  // lifetime is boot-or-takeover — a live user outranks the file).
  assert.equal(existsSync(join(DATA_DIR, "wake-credential.json")), false);
  const { sent: after, send: sendAfter } = collector();
  await srv2.handleIntent(sendAfter as never, JSON.stringify({ type: "user_message", text: "hi" }));
  assert.match(String(after[0]?.message), /no inference key/); // NOT the autonomous refusal
});

test("wakeBoot: a wrong secret on an enrolled volume is rejected and cleared", async () => {
  process.env.WADDLE_WAKE_AUTONOMY = "1";
  armWakeCredential({ secret: SECRET_B });
  const srv3 = buildApp();
  await srv3.wakeBoot();
  const health = await (await srv3.app.request("/health")).json();
  assert.equal(health.locked, true); // refused — never a silent TOFU re-enroll
  assert.equal(existsSync(join(DATA_DIR, "wake-credential.json")), false); // cleared, booting locked
  delete process.env.WADDLE_WAKE_AUTONOMY;
});
