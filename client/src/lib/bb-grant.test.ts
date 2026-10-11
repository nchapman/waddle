import { test } from "node:test";
import assert from "node:assert/strict";
import { machineAnchorId } from "./bb-grant.js";

const UUID_V5 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("machineAnchorId is a well-formed name-based (v5-shaped) uuid", async () => {
  const id = await machineAnchorId("879bff47-ea1c-577d-9ac8-1cb6f289b724");
  assert.match(id, UUID_V5, `not a v5-shaped uuid: ${id}`);
});

test("machineAnchorId is stable for the same space", async () => {
  const space = "b7d64543-fe27-5774-a174-a85aeee93a8f";
  assert.equal(await machineAnchorId(space), await machineAnchorId(space));
});

test("machineAnchorId differs per space — the multi-user collision invariant", async () => {
  // The shelf bug this guards against: a fixed anchor collides globally and
  // every account after the first gets a permanent bad_request push
  // rejection (RecordIdCollision). Different spaces MUST derive
  // different ids.
  const ids = await Promise.all(
    [
      "879bff47-ea1c-577d-9ac8-1cb6f289b724",
      "b7d64543-fe27-5774-a174-a85aeee93a8f",
      "00000000-0000-0000-0000-000000000000",
    ].map(machineAnchorId),
  );
  assert.equal(new Set(ids).size, ids.length, `ids collided: ${ids}`);
});

test("machineAnchorId matches the anchor actually shelved for the live prod proof", async () => {
  // Locked to the observed live values (2026-10-09 live enclave proof):
  // if this breaks, the derivation input changed and every existing
  // shelf's manifest/slot ids silently fork.
  assert.equal(
    await machineAnchorId("879bff47-ea1c-577d-9ac8-1cb6f289b724"),
    "b47a6b6c-cdde-556f-a8e6-18d1055a75db",
  );
  assert.equal(
    await machineAnchorId("b7d64543-fe27-5774-a174-a85aeee93a8f"),
    "1c3bf4d6-3b1a-5ee6-a536-1cb68e5e2316",
  );
});

// ── resolveSyncEndpoint: discovery, cache, and the retry-on-failure seam ──
// (localStorage + fetch stubbed; a fresh module import per case so the
//  in-memory endpointPromise doesn't leak between them.)

test("resolveSyncEndpoint: a failed discovery returns \"\" AND stays retryable", async () => {
  installLocalStorageStub();
  const calls: number[] = [];
  stubFetch(() => {
    calls.push(1);
    throw new Error("discovery down");
  });
  const m = await import("./bb-grant.js?ep-fail=" + Date.now());
  assert.equal(await m.resolveSyncEndpoint(), "");
  // Second call retries the wire (the promise resets on failure) — also "".
  assert.equal(await m.resolveSyncEndpoint(), "");
  assert.equal(calls.length, 2);
});

test("resolveSyncEndpoint: discovery resolves the endpoint and caches it in localStorage", async () => {
  const store = installLocalStorageStub();
  stubFetch(() => ({ ok: true, status: 200, json: async () => ({ syncEndpoint: "https://sync.example.com/api/v1" }) }));
  const m = await import("./bb-grant.js?ep-ok=" + Date.now());
  assert.equal(await m.resolveSyncEndpoint(), "https://sync.example.com/api/v1");
  assert.equal(store.get("waddle.bb-sync-endpoint"), "https://sync.example.com/api/v1");
  // A second resolve reuses the in-flight promise — no new fetch.
  assert.equal(await m.resolveSyncEndpoint(), "https://sync.example.com/api/v1");
});

test("resolveSyncEndpoint: a pre-seeded cache answers without any network", async () => {
  installLocalStorageStub(new Map([["waddle.bb-sync-endpoint", "https://cached.example/api/v1"]]));
  stubFetch(() => {
    throw new Error("MUST NOT FETCH when cached");
  });
  const m = await import("./bb-grant.js?ep-cache=" + Date.now());
  assert.equal(await m.resolveSyncEndpoint(), "https://cached.example/api/v1");
});

test("resolveSyncEndpoint: discovery without an endpoint is an honest failure", async () => {
  installLocalStorageStub();
  stubFetch(() => ({ ok: true, status: 200, json: async () => ({}) }));
  const m = await import("./bb-grant.js?ep-empty=" + Date.now());
  assert.equal(await m.resolveSyncEndpoint(), "");
});

/** localStorage stub (node has none). Returns the backing map. */
function installLocalStorageStub(preseed?: Map<string, string>): Map<string, string> {
  const store = preseed ?? new Map<string, string>();
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  return store;
}

function stubFetch(handler: () => { ok: boolean; status: number; json: () => Promise<unknown> } | never): void {
  (globalThis as { fetch: unknown }).fetch = async () => handler() as unknown as Response;
}
