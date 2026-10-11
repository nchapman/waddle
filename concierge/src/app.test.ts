/**
 * Route-level tests for the Hono concierge — the four auth tiers, the
 * /boot discovery contract (fresh mint, idempotent re-boot, observed-death
 * wake), the timer table writes, and the escrow/postbox routes. The
 * Platform seam is faked; the bb-JWT tier runs for real against a stubbed
 * JWKS endpoint.
 */
import { test } from "node:test";
import { generateKeyPairSync } from "node:crypto";
import assert from "node:assert/strict";
import { SignJWT, exportJWK } from "jose";

process.env.CONCIERGE_TOKEN = "devsecret";
process.env.CONCIERGE_BACKEND = "docker"; // no pool, no platform scans
process.env.CONCIERGE_JWKS_URL = "https://jwks.test/jwks.json";
process.env.CONCIERGE_ISSUER = "https://betterbase.dev";
process.env.CONCIERGE_AUDIENCE = "waddle-concierge";
delete process.env.STANDBY_CONFIG_REPO;
delete process.env.INSTANCE_DOMAIN_BASE;

// The bb JWT tier, for real: an RS256 keypair + a stubbed JWKS endpoint.
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = await exportJWK(publicKey);
let jwksFetches = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  if (String(input).includes("jwks.test")) {
    jwksFetches++;
    return new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return realFetch(input);
}) as typeof fetch;

const jwt = await new SignJWT({ sub: "user-1" })
  .setProtectedHeader({ alg: "RS256" })
  .setIssuer("https://betterbase.dev")
  .setAudience("waddle-concierge")
  .setExpirationTime("1h")
  .sign(privateKey);

const { buildApp } = await import("./app.js");
import type { Platform } from "./platform.js";

// The fake platform seam — records every verb, answers like a healthy one.
const verbs = { ensure: [] as string[], destroy: [] as string[], redeploy: [] as string[], rest: [] as string[] };
let ensureAnswers = ["started", "already running"];
const platform: Platform = {
  start: async (i) => `started ${i}`,
  rest: async (i) => (verbs.rest.push(i), `stopped ${i}`),
  statuses: async () => new Map(),
  statusRows: async () => new Map(),
  list: async () => [],
  ensure: async (i) => (verbs.ensure.push(i), ensureAnswers.shift() ?? "already running"),
  redeploy: async (i) => (verbs.redeploy.push(i), `redeployed ${i}`),
  destroy: async (i) => (verbs.destroy.push(i), `destroyed ${i}`),
  waitRunning: async () => true,
  awaitDns: async () => true,
};

const { app } = buildApp({ platform });
const post = (path: string, body: unknown, bearer?: string) =>
  app.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const get = (path: string, bearer?: string) =>
  app.request(path, bearer ? { headers: { authorization: `Bearer ${bearer}` } } : {});

const NAME_RE = /^waddle-u[0-9a-f]{8}-[0-9a-f]{6}$/;

test("/health is public and leaks nothing but counts", async () => {
  const res = await get("/health");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.service, "waddle-concierge");
  assert.equal(body.backend, "docker");
  assert.deepEqual(body.pool, { size: 0 });
});

test("/status is external-tier gated", async () => {
  assert.equal((await get("/status")).status, 401);
  const res = await get("/status", "devsecret");
  assert.equal(res.status, 200);
  assert.ok(Array.isArray((await res.json()).instances));
});

test("/boot refuses the shared secret: a machine identity names no user", async () => {
  const res = await post("/boot", {}, "devsecret");
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /user identity required/);
});

test("/boot with a bb JWT mints a user machine (202 waking), then serves it running", async () => {
  const first = await post("/boot", {}, jwt);
  assert.equal(first.status, 202);
  const body = await first.json();
  assert.match(body.instance, NAME_RE);
  assert.equal(body.status, "waking");
  assert.ok(body.url.startsWith(`https://${body.instance}.`));

  const again = await post("/boot", {}, jwt);
  assert.equal(again.status, 200);
  const body2 = await again.json();
  assert.equal(body2.instance, body.instance); // idempotent — same machine
  assert.equal(body2.status, "running");
  assert.deepEqual(verbs.ensure.slice(-2), [body.instance, body.instance]);
});

test("/handshake: bb JWT + matching presented name mints the session", async () => {
  const boot = await (await post("/boot", {}, jwt)).json();
  const res = await post("/handshake", { presented_instance: boot.instance }, jwt);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.instance, boot.instance);
  assert.ok(typeof body.session_token === "string");
});

test("/handshake: a presented name that disagrees with the registry is a 409 re-boot", async () => {
  const res = await post("/handshake", { presented_instance: "waddle-u00000000-deadbe" }, jwt);
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /re-boot/);
});

test("/handshake: secret tier mints for a known instance, refuses unknown ones — and the identity-less sentinel is refused by design", async () => {
  const boot = await (await post("/boot", {}, jwt)).json();
  const res = await post("/handshake", { instance: boot.instance }, "devsecret");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.instance, boot.instance);
  // Shared identity: the same session the JWT tier would mint.
  const viaJwt = await (await post("/handshake", { presented_instance: boot.instance }, jwt)).json();
  assert.equal(body.session_token, viaJwt.session_token);
  assert.equal((await post("/handshake", { instance: "waddle-u00000000-deadbe" }, "devsecret")).status, 403);
  // The k=1 residual, pinned as intent: a pre-adoption boot presents the
  // sentinel, which is in NO namespace — the gates refuse it, so an
  // identity-less boot stays row-less (platform clocks bound it instead).
  assert.equal((await post("/handshake", { instance: "unadopted" }, "devsecret")).status, 403);
});

test("/timer: session tier writes stop and wake rows; others 401; bad rows 400", async () => {
  const boot = await (await post("/boot", {}, jwt)).json();
  const { session_token } = await (await post("/handshake", { presented_instance: boot.instance }, jwt)).json();
  const stop = await post("/timer", { instance: boot.instance, action: "stop", due_ms: 3_600_000 }, session_token);
  assert.equal(stop.status, 200);
  assert.equal((await stop.json()).ok, true);
  const wake = await post("/timer", { instance: boot.instance, action: "wake", due_ms: 3_600_000, job_id: "job-1" }, session_token);
  assert.equal((await wake.json()).job_id, "job-1");
  // Refusals
  assert.equal((await post("/timer", { instance: boot.instance, action: "stop", due_ms: 1000 }, "devsecret")).status, 401);
  assert.equal((await post("/timer", { instance: boot.instance, action: "bogus", due_ms: 1000 }, session_token)).status, 400);
  assert.equal((await post("/timer", { instance: boot.instance, action: "wake", due_ms: 1000 }, session_token)).status, 400);
});

test("/boot/ready: external tier + allowed instance → ready; unknown → 403", async () => {
  const boot = await (await post("/boot", {}, jwt)).json();
  const res = await get(`/boot/ready?instance=${boot.instance}`, "devsecret");
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ready, true);
  assert.equal((await get("/boot/ready?instance=waddle-u00000000-deadbe", "devsecret")).status, 403);
  assert.equal((await get(`/boot/ready?instance=${boot.instance}`)).status, 401);
});

test("/handoff: secret tier arms; a bare pull hits the fire-gate (404 no-fire)", async () => {
  const boot = await (await post("/boot", {}, jwt)).json();
  const arm = await post("/handoff", { instance: boot.instance, credential: { secret: "s3cr3t" } }, "devsecret");
  assert.equal(arm.status, 200);
  assert.equal((await arm.json()).ok, true);
  assert.equal((await post("/handoff", { instance: boot.instance, credential: { secret: "x" } }, "devsecret-wrong")).status, 401);
  // The fire-gate IS the security story: armed ≠ releasable.
  const pull = await post("/handoff/pull", { instance: boot.instance }, "devsecret");
  assert.equal(pull.status, 404);
  assert.match((await pull.json()).error, /no-fire/);
  const clear = await post("/handoff", { instance: boot.instance, clear: true }, "devsecret");
  assert.equal((await clear.json()).cleared, true);
});

test("/handoff/pull: a sentinel caller (no user/standby shape) reaches the legacy path", async () => {
  // The k=1 fallback: "unadopted" bypasses the name gate toward the single
  // open fire window. No window open here → the honest 404.
  const res = await post("/handoff/pull", { instance: "unadopted" }, "devsecret");
  assert.equal(res.status, 404);
});

test("body caps: 1MiB default, 8MiB on the postbox route (413 over)", async () => {
  const boot = await (await post("/boot", {}, jwt)).json();
  const big = "x".repeat(2 * 1024 * 1024);
  assert.equal((await post("/handoff", { instance: boot.instance, credential: { secret: big } }, "devsecret")).status, 413);
  const { session_token } = await (await post("/handshake", { presented_instance: boot.instance }, jwt)).json();
  const huge = "x".repeat(9 * 1024 * 1024);
  assert.equal((await post("/handoff/post", { instance: boot.instance, blob: huge }, session_token)).status, 413);
  assert.equal((await post("/timer", "{not json", session_token)).status, 400);
});

test("postbox: session tier stores sealed mail, delivers exactly once", async () => {
  const boot = await (await post("/boot", {}, jwt)).json();
  const { session_token } = await (await post("/handshake", { presented_instance: boot.instance }, jwt)).json();
  assert.equal((await post("/handoff/post", { instance: boot.instance, blob: "nothing" }, "devsecret")).status, 401); // external tier ≠ writer
  const post1 = await post("/handoff/post", { instance: boot.instance, blob: "sealed-bytes" }, session_token);
  assert.equal(post1.status, 200);
  const pull = await post("/handoff/post/pull", { instance: boot.instance }, session_token);
  assert.equal(pull.status, 200);
  assert.equal(pull.headers.get("cache-control"), "no-store");
  assert.equal((await pull.json()).blob, "sealed-bytes");
  assert.equal((await post("/handoff/post/pull", { instance: boot.instance }, session_token)).status, 404); // one delivery
});

test("/boot fresh: observed-death wake retires + destroys the old name, mints a new one", async () => {
  const before = await (await post("/boot", {}, jwt)).json();
  ensureAnswers = ["started"]; // the fresh mint's ensure — deterministic 202
  const res = await post("/boot", { fresh: true }, jwt);
  assert.equal(res.status, 202);
  const after = await res.json();
  assert.match(after.instance, NAME_RE);
  assert.notEqual(after.instance, before.instance);
  // The destroy is fire-and-forget — await the observable, not a clock.
  const deadline = Date.now() + 2000;
  while (!verbs.destroy.includes(before.instance) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.ok(verbs.destroy.includes(before.instance));
  // The registry binds the fresh name; the tombstone keeps the old one dead.
  const rebind = await (await post("/boot", {}, jwt)).json();
  assert.equal(rebind.instance, after.instance);
});

test("the bb JWT tier really verified against the stubbed JWKS", async () => {
  // The JWT routes above passing means jose accepted our signature — which
  // is only possible if it fetched the stubbed JWKS at least once.
  assert.ok(jwksFetches >= 1);
});
