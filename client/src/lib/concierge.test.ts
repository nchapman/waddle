import { test } from "node:test";
import assert from "node:assert/strict";
import { wakeInstance, pollUntilHealthy, assignStandby } from "./concierge.js";
import { CONCIERGE_TOKEN } from "./config.js";

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

test("wakeInstance posts the verb with the auth token (bb token wins)", async () => {
  const { calls } = stubFetch(() => ({ ok: true }));
  const r = await wakeInstance(async () => "bb-token");
  assert.deepEqual(r, { ok: true });
  assert.match(calls[0]!.url, /\/wake$/);
  assert.equal(bearer(calls[0]!), "Bearer bb-token");
});

test("wakeInstance falls back to the shared-secret env token and reports refusals", async () => {
  const { calls } = stubFetch(() => ({ ok: false, body: "nope" }));
  const r = await wakeInstance(async () => null);
  assert.equal(r.ok, false);
  assert.match(r.detail!, /concierge refused \(503\)/);
  assert.equal(bearer(calls[0]!), `Bearer ${CONCIERGE_TOKEN}`);
});

test("wakeInstance reports a failed concierge call as unreachable", async () => {
  // The structural timeout guard (AbortSignal on the /wake fetch) bounds a
  // SILENT stall; this pins the loud-failure path through the same return.
  stubFetch(() => ({ throwErr: new Error("ECONNREFUSED") }));
  const r = await wakeInstance(async () => null);
  assert.equal(r.ok, false);
  assert.match(r.detail!, /concierge unreachable/);
});

test("assignStandby zone-binds: a URL outside the primary's domain is rejected", async () => {
  stubFetch(() => ({ ok: true, body: { name: "waddle-standby-1", url: "https://evil.example.net" } }));
  const got = await assignStandby(async () => null, ".containers.tinfoil.dev");
  assert.equal(got, null); // never hand out a host the TOFU pin cannot cover
});

test("assignStandby returns the URL when the host is inside the zone", async () => {
  const { calls } = stubFetch(() => ({
    ok: true,
    body: { name: "waddle-standby-1", url: "https://waddle-standby-1.containers.tinfoil.dev" },
  }));
  const got = await assignStandby(async () => "bb-token", ".containers.tinfoil.dev");
  assert.equal(got, "https://waddle-standby-1.containers.tinfoil.dev");
  assert.match(calls[0]!.url, /\/assign$/);
});

test("assignStandby: non-ok or unreachable → null (caller falls back to /wake)", async () => {
  stubFetch(() => ({ ok: false }));
  assert.equal(await assignStandby(async () => null, ".z"), null);
  stubFetch(() => ({ throwErr: new Error("timeout") }));
  assert.equal(await assignStandby(async () => null, ".z"), null);
});

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
