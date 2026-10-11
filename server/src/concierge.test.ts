import { it } from "node:test";
import assert from "node:assert/strict";

/** Cattle-name adoption (server/src/concierge.ts): the machine cannot
 *  know its own name (hostname = inner container id, live-proven; env
 *  injection changes the measurement) — it adopts the name the
 *  concierge resolves for it at handshake/pull. These tests stub fetch. */
process.env.CONCIERGE_URL = process.env.CONCIERGE_URL ?? "https://concierge.test";
const { handshakeConcierge, pullHandoff, currentInstance } = await import("./concierge.js");

function stubFetch(handler: (url: string, init?: { body?: string }) => { status: number; json?: unknown }) {
  const calls: { url: string; body?: string }[] = [];
  (globalThis as { fetch: unknown }).fetch = async (url: string, init?: { body?: string }) => {
    calls.push({ url: String(url), body: init?.body });
    const r = handler(String(url), init);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.json } as unknown as Response;
  };
  return calls;
}

it("starts on the baked default and adopts the handshake-resolved name", async () => {
  assert.equal(currentInstance(), "unadopted");
  stubFetch(() => ({ status: 200, json: { session_token: "t1", instance: "waddle-uabcdef12-345678" } }));
  assert.ok(await handshakeConcierge("bearer-x"));
  assert.equal(currentInstance(), "waddle-uabcdef12-345678");
});

it("relays the client-presented name in the handshake body (fail-closed input)", async () => {
  let body: Record<string, unknown> | undefined;
  stubFetch((_url, init) => {
    body = init?.body ? JSON.parse(init.body) : undefined;
    return { status: 200, json: { session_token: "t9", instance: "waddle-uabcdef12-345678" } };
  });
  assert.ok(await handshakeConcierge("bearer-x", "waddle-uabcdef12-345678"));
  assert.equal(body!.presented_instance, "waddle-uabcdef12-345678");
  // a refusal (409) is final — the machine reports no session
  stubFetch(() => ({ status: 409 }));
  assert.ok(!(await handshakeConcierge("bearer-x", "waddle-u99999999-000000")));
});

it("rejects malformed adopted names (shape guard) — keeps the current", async () => {
  const before = currentInstance();
  stubFetch(() => ({ status: 200, json: { session_token: "t2", instance: "not a name!" } }));
  assert.ok(await handshakeConcierge("bearer-x"));
  assert.equal(currentInstance(), before); // unchanged — no crash, no re-key
});

it("a failed handshake adopts nothing", async () => {
  const before = currentInstance();
  stubFetch(() => ({ status: 401 }));
  assert.ok(!(await handshakeConcierge("bearer-x")));
  assert.equal(currentInstance(), before);
});

it("the wake-boot pull adopts the served row's name before returning the credential", async () => {
  let seenBody: Record<string, unknown> | undefined;
  stubFetch((_url, init) => {
    seenBody = init?.body ? JSON.parse(init.body) : undefined;
    return { status: 200, json: { credential: { secret: "s" }, instance: "waddle-uabcdef12-999999" } };
  });
  const before = currentInstance();
  const cred = await pullHandoff();
  assert.deepEqual(cred, { secret: "s" });
  assert.equal(currentInstance(), "waddle-uabcdef12-999999");
  // The pull request itself rode the pre-adoption name (module state):
  assert.equal(seenBody!.instance, before);
});

it("a transient handshake failure retries and still adopts (a blip is not an identity refusal)", async () => {
  let n = 0;
  (globalThis as { fetch: unknown }).fetch = async () => {
    n++;
    if (n === 1) throw new Error("ECONNRESET");
    return { ok: true, status: 200, json: async () => ({ session_token: "t-retry", instance: "waddle-uaaaaaaaa-111111" }) } as unknown as Response;
  };
  assert.ok(await handshakeConcierge("bearer-x", "waddle-uaaaaaaaa-111111"));
  assert.equal(currentInstance(), "waddle-uaaaaaaaa-111111");
});

it("a definitive 409 refusal is final — no retries burn the window", async () => {
  let n = 0;
  (globalThis as { fetch: unknown }).fetch = async () => {
    n++;
    return { ok: false, status: 409, json: async () => ({}) } as unknown as Response;
  };
  assert.ok(!(await handshakeConcierge("bearer-x", "waddle-uzzzzzzzz-999999")));
  assert.equal(n, 1, "one request — refusal is not retried");
});


it("a 401 on a table write drops the session — conciergeActive() must go false (the sleep gate reads it)", async () => {
  stubFetch((url) =>
    url.endsWith("/handshake")
      ? { status: 200, json: { session_token: "t-live", instance: "waddle-uabcdef12-345678" } }
      : { status: 401 },
  );
  assert.ok(await handshakeConcierge("bearer-x"));
  const { conciergeActive, writeTimer } = await import("./concierge.js");
  assert.equal(conciergeActive(), true);
  assert.equal(await writeTimer({ action: "stop", dueMs: 5_000 }), false);
  assert.equal(conciergeActive(), false, "a dead session must not fake wake cover");
  // And with no session, writes are refused before any wire call.
  assert.equal(await writeTimer({ action: "stop", dueMs: 5_000 }), false);
});

it("escrow verbs ride the given bearer (arm) and the session (postbox) with the right bodies", async () => {
  const { armHandoff, postPostbox } = await import("./concierge.js");
  stubFetch(() => ({ status: 200, json: { session_token: "t-live", instance: "waddle-uabcdef12-345678" } }));
  assert.ok(await handshakeConcierge("bearer-x"));
  const calls: Array<{ url: string; body: Record<string, unknown>; auth: string }> = [];
  (globalThis as { fetch: unknown }).fetch = async (url: string, init?: { body?: string; headers?: Record<string, string> }) => {
    calls.push({ url: String(url), body: JSON.parse(init?.body ?? "{}"), auth: init?.headers?.authorization ?? "" });
    return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
  };
  const cred = { secret: "s", schedules: [] };
  assert.equal(await armHandoff(cred, "the-bearer", 3600_000), true);
  assert.equal(await postPostbox("sealed-blob"), true);
  const arm = calls.find((c) => c.url.endsWith("/handoff"))!;
  assert.equal(arm.auth, "Bearer the-bearer", "arm rides the CALLER's bearer, not the session");
  assert.deepEqual(arm.body.credential, cred);
  assert.equal(arm.body.ttl_ms, 3600_000);
  const post = calls.find((c) => c.url.endsWith("/handoff/post"))!;
  assert.equal(post.body.blob, "sealed-blob");
});

it("postbox pull returns the sealed blob or null (no mail / unreachable — both normal)", async () => {
  const { pullPostbox } = await import("./concierge.js");
  stubFetch((url) =>
    url.endsWith("/handshake")
      ? { status: 200, json: { session_token: "t-live", instance: "waddle-uabcdef12-345678" } }
      : { status: 200, json: { blob: "sealed" } },
  );
  assert.ok(await handshakeConcierge("bearer-x"), "pull is session-tier — mint first");
  assert.equal(await pullPostbox(), "sealed");
  stubFetch(() => ({ status: 404 }));
  assert.equal(await pullPostbox(), null);
  stubFetch(() => ({ status: 200, json: { blob: "" } })); // empty-string blob = nothing
  assert.equal(await pullPostbox(), null);
});

it("a failed arm reports false — the sleep gate logs the degraded wake", async () => {
  const { armHandoff } = await import("./concierge.js");
  stubFetch(() => ({ status: 500 }));
  assert.equal(await armHandoff({ secret: "s" }, "b", 1000), false);
});

it("pullHandoff survives refusals and malformed rows — null, never a throw", async () => {
  const { pullHandoff } = await import("./concierge.js");
  stubFetch(() => ({ status: 404 }));
  assert.equal(await pullHandoff(), null);
  stubFetch(() => ({ status: 200, json: { credential: "not-an-object" } }));
  assert.equal(await pullHandoff(), null);
  stubFetch(() => ({ status: 200, json: {} }));
  assert.equal(await pullHandoff(), null);
});
