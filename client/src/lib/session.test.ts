/**
 * Session custody tests — the client's side of the unlock contract: the
 * 64-byte secret is generated once and held locally, the unlock POST
 * carries secret+nonce+(grant/background) and — live mode only — the
 * machine's name derived from the enclave URL (the concierge's handshake
 * mints only on registry ≡ presented), and the returned token persists
 * for gated calls + the WSS. Fetch and localStorage are stubbed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

// localStorage stub (node has none; the module touches it synchronously).
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const { getSecret, forgetSecret, getToken, unlock, getState } = await import("./session.js");

const ENCLAVE = "https://waddle-uabcdef12-345678.ddg-waddle.containers.tinfoil.dev";

function stubFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  (globalThis as { fetch: unknown }).fetch = async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = handler(String(url), init);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
    } as unknown as Response;
  };
  return calls;
}

test("the secret is 64 bytes, generated once, and forgotten together with the token", () => {
  const s1 = getSecret();
  assert.equal(Buffer.from(s1, "base64").length, 64, "the root of all server-side key material");
  assert.equal(getSecret(), s1, "stable — a new call must not rotate it");
  store.set("waddle.token", "t1");
  forgetSecret();
  assert.equal(getToken(), null);
  assert.notEqual(getSecret(), s1, "after forget, a fresh secret is minted");
});

test("unlock posts secret+nonce+extras and the LIVE-MODE instance label from the URL", async () => {
  const calls = stubFetch(() => ({ status: 200, body: { token: "sess-1", enrolled: true, background: false } }));
  const grant = { endpoint: "https://sync.example.com/api/v1", token: "bb-tok", spaceId: "sp", epoch: 3, anchorId: "an" };
  const res = await unlock(
    { fetch: (globalThis as { fetch: typeof fetch }).fetch },
    ENCLAVE,
    "tk-inference",
    grant,
    true,
  );
  assert.deepEqual(res, { token: "sess-1", enrolled: true, background: false });
  assert.equal(getToken(), "sess-1");

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, `${ENCLAVE}/unlock`);
  const sent = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>;
  assert.equal(sent.secret, getSecret(), "the locally-held secret rides the attested channel");
  assert.equal(typeof sent.nonce, "string");
  assert.equal(sent.inferenceKey, "tk-inference");
  assert.deepEqual(sent.bb, grant);
  assert.equal(sent.background, true);
  assert.equal(sent.instance, "waddle-uabcdef12-345678", "first hostname label — the registry-match input");
});

test("a refused unlock surfaces the server's error and stores no token", async () => {
  store.delete("waddle.token");
  stubFetch(() => ({ status: 401, body: { error: "wrong secret" } }));
  await assert.rejects(
    unlock({ fetch: (globalThis as { fetch: typeof fetch }).fetch }, ENCLAVE),
    /wrong secret/,
  );
  assert.equal(getToken(), null);
});

test("getState rides the stored bearer token", async () => {
  store.set("waddle.token", "sess-3");
  const calls = stubFetch(() => ({ status: 200, body: { unlocked: true, enrolled: true, events: [] } }));
  const state = await getState({ fetch: (globalThis as { fetch: typeof fetch }).fetch }, ENCLAVE);
  assert.equal(state.unlocked, true);
  const headers = (calls[0]!.init as { headers?: Record<string, string> } | undefined)?.headers;
  assert.equal(headers?.Authorization, "Bearer sess-3");
});
