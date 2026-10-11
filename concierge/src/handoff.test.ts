import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHandoffStore } from "./handoff.js";

// Today's payload shape: an opaque bag the store never interprets.
const CRED = { autonomyKey: "ak_s3cret", schedules: [{ id: "j1", title: "t", prompt: "p", enabled: true }] };

function store(opts: Parameters<typeof createHandoffStore>[0] = {}) {
  let t = 1_000_000;
  const s = createHandoffStore({ now: () => t, ...opts });
  const tick = (ms: number) => (t += ms);
  return { s, tick };
}

describe("wake handoff store", () => {
  it("releases only after a wake fire, one-shot", () => {
    const { s } = store();
    s.arm("waddle", CRED);
    assert.equal((s.release("waddle") as { reason?: string }).reason, "no-fire");
    s.markWakeFired("waddle");
    const got = s.release("waddle") as { cred: Record<string, unknown>; armed_ms_ago: number };
    assert.deepEqual(got.cred, CRED); // the whole bag comes back, untouched
    // one-shot per fire: a second pull (e.g. a racing standby) is denied
    assert.equal((s.release("waddle") as { reason?: string }).reason, "no-fire");
  });

  it("denies past the release window even with a live row", () => {
    const { s, tick } = store({ releaseWindowMs: 60_000 });
    s.arm("waddle", CRED);
    s.markWakeFired("waddle");
    tick(60_001);
    assert.equal((s.release("waddle") as { reason?: string }).reason, "window");
  });

  it("expires armed rows lazily and reports absent rows", () => {
    const { s, tick } = store({ ttlMs: 120_000 });
    s.arm("waddle", CRED);
    tick(120_001);
    s.markWakeFired("waddle");
    assert.equal((s.release("waddle") as { reason?: string }).reason, "expired");
    assert.equal(s.status("waddle").armed, false);
    s.markWakeFired("waddle");
    assert.equal((s.release("waddle") as { reason?: string }).reason, "absent");
  });

  it("rejects empty credential bags (an arm must carry real payload)", () => {
    const { s } = store();
    assert.throws(() => s.arm("waddle", {}));
    assert.throws(() => s.arm("waddle", undefined as unknown as Record<string, unknown>));
  });

  it("clamps ttl overrides into [60s, max]", () => {
    const { s } = store({ ttlMs: 600_000 });
    assert.equal(s.arm("a", CRED, 1).expires_in_ms, 60_000);
    assert.equal(s.arm("b", CRED, 999_999_999).expires_in_ms, 600_000);
  });

  it("default release window is 3 minutes (pinned: the standby-steal exposure scale)", () => {
    const { s, tick } = store(); // no override — the production default
    s.arm("waddle", CRED);
    s.markWakeFired("waddle");
    tick(3 * 60_000);
    assert.equal(s.windowOpen("waddle"), true, "still open at exactly 3min");
    tick(1);
    assert.equal(s.windowOpen("waddle"), false, "closed at 3min+1");
    assert.equal((s.release("waddle") as { reason?: string }).reason, "window");
  });

  it("windowOpen mirrors the release gate; clear disarms", () => {
    const { s } = store({ releaseWindowMs: 60_000 });
    s.arm("waddle", CRED);
    assert.equal(s.windowOpen("waddle"), false);
    s.markWakeFired("waddle");
    assert.equal(s.windowOpen("waddle"), true);
    s.clear("waddle");
    assert.equal(s.windowOpen("waddle"), false);
    assert.equal(s.status("waddle").armed, false);
    s.markWakeFired("waddle");
    assert.equal((s.release("waddle") as { reason?: string }).reason, "absent");
  });

  it("fires are per-instance; status never leaks the secret", () => {
    const { s } = store();
    s.arm("waddle", CRED);
    s.markWakeFired("waddle");
    assert.equal((s.release("other") as { reason?: string }).reason, "no-fire");
    assert.ok((s.release("waddle") as { cred?: Record<string, unknown> }).cred);
    assert.ok(!JSON.stringify(s.status("waddle")).includes("ak_s3cret"));
  });
});

it("armed() lists armed row names — the /handoff/pull k=1 fallback resolver", () => {
  const h = createHandoffStore({ now: () => 1_000 });
  assert.deepEqual(h.armed(), []);
  h.arm("waddle-ud3b16438-777d2b", { secret: "x" });
  h.arm("waddle", { secret: "y" });
  assert.deepEqual(h.armed().sort(), ["waddle", "waddle-ud3b16438-777d2b"]);
});

it("armed() prunes expired rows — the count is 'armed NOW', not 'armed ever'", () => {
  let t = 1_000;
  const h = createHandoffStore({ now: () => t, ttlMs: 60_000 });
  h.arm("waddle-uaaaaaaaa-111111", { secret: "x" });
  t += 61_000; // past ttl
  h.arm("waddle-ubbbbbbbb-222222", { secret: "y" });
  assert.deepEqual(h.armed(), ["waddle-ubbbbbbbb-222222"]);
});

it("singleOpenWindow serves only an unambiguous window; anyWindowOpen feeds the pool's fill deferral", () => {
  let t = 1_000;
  const h = createHandoffStore({ now: () => t, releaseWindowMs: 180_000 });
  assert.equal(h.singleOpenWindow(), null);
  assert.equal(h.anyWindowOpen(), false);
  h.arm("waddle-uaaaaaaaa-111111", { secret: "x" });
  h.markWakeFired("waddle-uaaaaaaaa-111111");
  assert.equal(h.singleOpenWindow(), "waddle-uaaaaaaaa-111111");
  assert.equal(h.anyWindowOpen(), true);
  // Two open windows = ambiguity = deny (k>1 residual)
  h.arm("waddle-ubbbbbbbb-222222", { secret: "y" });
  h.markWakeFired("waddle-ubbbbbbbb-222222");
  assert.equal(h.singleOpenWindow(), null);
  assert.equal(h.anyWindowOpen(), true);
  // Window closed by time
  t += 181_000;
  assert.equal(h.singleOpenWindow(), null);
  assert.equal(h.anyWindowOpen(), false);
});
