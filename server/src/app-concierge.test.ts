/**
 * The unlock flow's concierge leg, end to end: handshake (shared-secret
 * tier under a configured dev identity), idle-stop renewal write, and the
 * sealed postbox merge — with a stubbed concierge on globalThis.fetch.
 * Separate process from app.test because CONCIERGE_URL/SECRET are read at
 * module load. (The identity-less sentinel handshake is a different,
 * documented leg — the concierge's gates 403 it by design; see the
 * sentinel pin in concierge/src/app.test.ts.)
 */
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";

const DATA_DIR = mkdtempSync(join(tmpdir(), "waddle-appc-"));
process.env.DATA_DIR = DATA_DIR;
process.env.CONCIERGE_URL = "https://concierge.test";
process.env.CONCIERGE_SHARED_SECRET = "ssh-secret";
process.env.WADDLE_INSTANCE = "dev-box"; // the dev shape: a configured identity the concierge's gates accept
delete process.env.TINFOIL_API_KEY;

const SECRET = randomBytes(64).toString("base64");
const INSTANCE = "waddle-uabcdef12-345678"; // what the handshake response teaches (adoption)

const { sealPostbox } = await import("./postbox.js");
const { seedSchedules, listSchedules } = await import("./schedules.js");

// Pre-plant a stale schedule: the run's mail carries its id as a
// done-marker tombstone, and the merge must drop it.
const iso = new Date().toISOString();
seedSchedules([{ id: "stale-1", title: "stale", prompt: "p", enabled: true, createdAt: iso, at: new Date(Date.now() + 3600_000).toISOString() }]);

const blob = sealPostbox(SECRET, {
  events: [{ type: "message", role: "user", text: "unattended output from the run", at: iso }],
  schedules: [{ id: "mail-1", title: "mail", prompt: "p", enabled: false, createdAt: iso, at: iso }],
  cancelledIds: ["stale-1"],
});

const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  calls.push({ url, body });
  if (url.endsWith("/handshake")) return json({ session_token: "sess-1", instance: INSTANCE });
  if (url.endsWith("/timer")) return json({ ok: true });
  if (url.endsWith("/handoff/post/pull")) return json({ blob });
  return json({ error: "unexpected" }, 404);
}) as typeof fetch;

const { buildApp } = await import("./app.js");
const { app } = buildApp();

test("unlock handshakes with the shared secret, renews the stop row, merges the mail", async () => {
  const res = await app.request("/unlock", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: SECRET, nonce: randomBytes(16).toString("base64") }),
  });
  assert.equal(res.status, 200);
  const { token } = await res.json();

  // The sealed log tells the story: mail delivered, then the merge marker.
  const state = await (await app.request("/state", { headers: { authorization: `Bearer ${token}` } })).json();
  const texts = state.events.filter((e: { type: string }) => e.type === "message").map((e: { text: string }) => e.text);
  assert.ok(texts.some((t: string) => t.includes("unattended output from the run")));
  assert.ok(texts.some((t: string) => t.includes("postbox merged — 1 events")));

  // Schedule truth: the mail's row merged in, the tombstoned stale row gone.
  const ids = listSchedules().map((s) => s.id);
  assert.ok(ids.includes("mail-1"));
  assert.ok(!ids.includes("stale-1"));

  // Wire shapes: the configured identity goes out, the response's name is
  // adopted, and every follow-up write keys on the adopted instance.
  const hs = calls.find((c) => c.url.endsWith("/handshake"));
  assert.ok(hs, "handshake sent");
  assert.equal(hs?.body.instance, "dev-box");
  const stop = calls.find((c) => c.url.endsWith("/timer") && c.body.action === "stop");
  assert.ok(stop, "idle-stop renewal written");
  assert.equal(stop?.body.instance, INSTANCE); // adopted from the handshake
  assert.ok(Number(stop?.body.due_ms) > 0);
  const pull = calls.find((c) => c.url.endsWith("/handoff/post/pull"));
  assert.ok(pull, "postbox pulled");
  assert.equal(pull?.body.instance, INSTANCE);
  globalThis.fetch = realFetch;
});
