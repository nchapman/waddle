import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHandoffStore } from "./handoff.js";

const CRED = { secret: "s3cret", inferenceKey: "tk_x" };

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
    const got = s.release("waddle") as { secret: string; inferenceKey?: string; armed_ms_ago: number };
    assert.equal(got.secret, CRED.secret);
    assert.equal(got.inferenceKey, CRED.inferenceKey);
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

  it("clamps ttl overrides into [60s, max]", () => {
    const { s } = store({ ttlMs: 600_000 });
    assert.equal(s.arm("a", CRED, 1).expires_in_ms, 60_000);
    assert.equal(s.arm("b", CRED, 999_999_999).expires_in_ms, 600_000);
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
    assert.ok((s.release("waddle") as { secret?: string }).secret);
    assert.ok(!JSON.stringify(s.status("waddle")).includes("s3cret"));
  });
});
