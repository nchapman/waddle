import { test } from "node:test";
import assert from "node:assert/strict";
import { pollUntilHealthy, bootInstance, pollBootReady, awaitMachineReady } from "./concierge.js";

type Responder = { ok?: boolean; body?: unknown; throwErr?: Error };

/** fetch stub: per-URL responder; captures the request shape. */
function stubFetch(respond: (url: string, init?: RequestInit) => Responder): {
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const r = respond(url, init);
    if (r.throwErr) throw r.throwErr;
    return {
      ok: r.ok,
      status: r.ok ? 200 : 503,
      json: async () => r.body,
      text: async () => String(r.body ?? ""),
    } as Response;
  }) as typeof fetch;
  return { calls };
}

const bearer = (call: { init?: RequestInit }): string => {
  const h = call.init!.headers as Record<string, string | undefined>;
  return h.Authorization ?? "";
};






test("pollUntilHealthy ticks and gives up after the attempts run out", async () => {
  stubFetch(() => ({ ok: false }));
  const ticks: number[] = [];
  const healthy = await pollUntilHealthy("http://x", 3, (i) => ticks.push(i), 1);
  assert.equal(healthy, false);
  assert.deepEqual(ticks, [1, 2, 3]);
});

test("pollUntilHealthy stops at the first healthy answer", async () => {
  let n = 0;
  stubFetch(() => ({ ok: ++n >= 2 }));
  const ticks: number[] = [];
  const healthy = await pollUntilHealthy("http://x", 10, (i) => ticks.push(i), 1);
  assert.equal(healthy, true);
  assert.deepEqual(ticks, [1]); // second probe answered ok — no further ticks
});

// ── bootInstance (discovery) ────────────────────────────────────────────

test("bootInstance resolves my machine: in-zone URL, waking flag honored", async () => {
  const { calls } = stubFetch((url) =>
    url.includes("/boot")
      ? { ok: true, body: { url: "https://waddle-u123abc-dead42.ddg-waddle.containers.tinfoil.dev", instance: "waddle-u123abc-dead42", status: "waking", detail: "deployed" } }
      : { ok: true },
  );
  const r = await bootInstance(async () => "tok", 150_000, "ddg-waddle.containers.tinfoil.dev");
  assert.equal(r.ok, true);
  assert.equal(r.waking, true);
  assert.match(r.url!, /waddle-u123abc-dead42\.ddg-waddle/);
  assert.match(bearer(calls[0]!), /^Bearer tok$/);
});

test("bootInstance refuses an out-of-zone machine URL", async () => {
  stubFetch(() => ({ ok: true, body: { url: "https://evil.example.com", status: "running" } }));
  const r = await bootInstance(async () => "tok", 150_000, "ddg-waddle.containers.tinfoil.dev");
  assert.equal(r.ok, false);
  assert.match(r.detail!, /unusable machine URL/);
});

test("bootInstance: status running means no wake wait", async () => {
  stubFetch(() => ({ ok: true, body: { url: "https://waddle-u123abc-dead42.ddg-waddle.containers.tinfoil.dev", status: "running" } }));
  const r = await bootInstance(async () => "tok", 150_000, "ddg-waddle.containers.tinfoil.dev");
  assert.equal(r.waking, false);
});

test("bootInstance without a session says so — no request leaves", async () => {
  const { calls } = stubFetch(() => ({ ok: true }));
  const r = await bootInstance(async () => null);
  assert.equal(r.ok, false);
  assert.match(r.detail!, /no betterbase session/);
  assert.equal(calls.length, 0);
});

test("bootInstance reports a concierge refusal with its status", async () => {
  stubFetch(() => ({ ok: false, body: "user identity required" }));
  const r = await bootInstance(async () => "tok", 150_000, "ddg-waddle.containers.tinfoil.dev");
  assert.equal(r.ok, false);
  assert.match(r.detail!, /concierge refused \(503\)/);
});

test("bootInstance refuses when no zone is known (dev shape) or the URL is malformed", async () => {
  stubFetch(() => ({ ok: true, body: { url: "https://waddle-u12345678-dead42.ddg-waddle.containers.tinfoil.dev", status: "running" } }));
  assert.match((await bootInstance(async () => "tok", 150_000, "")).detail!, /unusable/);
  stubFetch(() => ({ ok: true, body: { url: "not-a-url", status: "running" } }));
  assert.match((await bootInstance(async () => "tok", 150_000, "ddg-waddle.containers.tinfoil.dev")).detail!, /unusable/);
});

test("bootInstance zone check has a label boundary — evil<tinfoil.dev> suffixes do not pass", async () => {
  stubFetch(() => ({ ok: true, body: { url: "https://evilddg-waddle.containers.tinfoil.dev", status: "running" } }));
  const r = await bootInstance(async () => "tok", 150_000, "ddg-waddle.containers.tinfoil.dev");
  assert.equal(r.ok, false);
});

test("bootInstance reports a silent stall as a stall, not unreachable", async () => {
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(Object.assign(new Error("aborted due to timeout"), { name: "TimeoutError" })));
    })) as typeof fetch;
  const r = await bootInstance(async () => "tok", 25, "ddg-waddle.containers.tinfoil.dev");
  assert.match(r.detail!, /stalled/);
});


test("pollBootReady asks the CONCIERGE (never the machine) and returns on its 200", async () => {
  const { calls } = stubFetch((url) => ({ ok: url.includes("ready") }));
  const r = await pollBootReady(async () => "tok", "waddle-u12345678-dead42", 3, undefined, 1);
  assert.equal(r, true);
  assert.match(calls[0]!.url, /\/boot\/ready\?instance=/);
});

test("pollBootReady gives up after its attempt budget", async () => {
  stubFetch(() => ({ ok: false }));
  const r = await pollBootReady(async () => "tok", "x", 2, undefined, 1);
  assert.equal(r, false);
});

test("bootInstance forwards fresh=true when the client watched a machine die", async () => {
  const { calls } = stubFetch(() => ({ ok: true, body: { url: "https://waddle-u12345678-dead42.ddg-waddle.containers.tinfoil.dev", status: "waking" } }));
  await bootInstance(async () => "tok", 150_000, "ddg-waddle.containers.tinfoil.dev", true);
  assert.deepEqual(JSON.parse(String(calls[0]!.init!.body)), { fresh: true });
});

// ── awaitMachineReady (the unconditional gate) ─────────────────────────

test("awaitMachineReady gates a 'running' boot through the concierge before any machine fetch", async () => {
  // /boot said "running" — the OLD flow skipped the gate and hit the
  // machine's name directly. The gate must still ask the concierge first.
  let readyFlips = 0;
  const { calls } = stubFetch((url) =>
    url.includes("/boot/ready")
      ? { ok: ++readyFlips >= 2 } // not-ready once, then ready
      : { ok: true }, // the machine /health leg
  );
  const machine = "https://waddle-u12345678-dead42.ddg-waddle.containers.tinfoil.dev";
  const r = await awaitMachineReady(async () => "tok", { url: machine, instance: "waddle-u12345678-dead42", waking: false }, undefined, { readyAttempts: 5, healthAttempts: 5, intervalMs: 1 });
  assert.equal(r.ready, true);
  assert.equal(r.healthy, true);
  const firstMachineHit = calls.findIndex((c) => c.url.startsWith(machine));
  const readyCalls = calls.filter((c) => c.url.includes("/boot/ready"));
  assert.ok(readyCalls.length >= 2, "the gate polled the concierge, not the machine");
  assert.ok(firstMachineHit > -1 && firstMachineHit >= readyCalls.length - 1, "no machine fetch before the gate cleared");
});

test("awaitMachineReady never touches the machine's name while the concierge says not-ready", async () => {
  const { calls } = stubFetch((url) => ({ ok: !url.includes("/boot/ready") }));
  const machine = "https://waddle-u12345678-dead42.ddg-waddle.containers.tinfoil.dev";
  const r = await awaitMachineReady(async () => "tok", { url: machine, instance: "waddle-u12345678-dead42", waking: true }, undefined, { readyAttempts: 3, healthAttempts: 3, intervalMs: 1 });
  assert.equal(r.ready, false, "gate exhausted");
  assert.equal(r.healthy, false);
  assert.equal(calls.filter((c) => c.url.startsWith(machine)).length, 0, "the machine's DNS name was never queried — no NXDOMAIN poisoning");
});
