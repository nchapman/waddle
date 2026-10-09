import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPool, envInt, standbyNameRe, isUnclaimed, type PoolDeps } from "./pool.js";

interface Harness {
  deps: PoolDeps;
  booted: string[];
  destroyed: string[];
  healthy: Set<string>;
  clock: { t: number };
}

function harness(names: string[] = []): Harness {
  const h = {
    booted: [] as string[],
    destroyed: [] as string[],
    healthy: new Set<string>(),
    clock: { t: 1_000 },
    deps: undefined as unknown as PoolDeps,
  };
  let i = 0;
  h.deps = {
    boot: async (n) => {
      h.booted.push(n);
    },
    destroy: async (n) => {
      h.destroyed.push(n);
      h.healthy.delete(n);
    },
    health: async (n) => h.healthy.has(n),
    urlFor: (n) => `https://${n}.example`,
    nextName: () => names[i++] ?? `standby-${i}`,
    now: () => h.clock.t,
    log: () => undefined,
  };
  return h;
}

describe("warm-standby pool", () => {
  it("size 0 never boots anything", async () => {
    const h = harness();
    const pool = createPool({ size: 0, ttlMs: 60_000 }, h.deps);
    await pool.tick();
    assert.equal(h.booted.length, 0);
    assert.equal(pool.assign(), null);
  });

  it("boots one per tick, promotes on health, assigns warm only", async () => {
    const h = harness(["s1", "s2"]);
    const pool = createPool({ size: 1, ttlMs: 60_000 }, h.deps);
    await pool.tick();
    assert.deepEqual(h.booted, ["s1"]);
    assert.equal(pool.assign(), null, "booting ≠ warm");

    h.healthy.add("s1");
    await pool.tick(); // promote; size satisfied → no new boot
    assert.deepEqual(h.booted, ["s1"]);

    const got = pool.assign();
    assert.equal(got?.name, "s1");
    assert.equal(got?.url, "https://s1.example");

    await pool.tick(); // claimed machine left the pool → replacement boots
    assert.deepEqual(h.booted, ["s1", "s2"]);
  });

  it("destroys TTL-expired standbys and replaces them", async () => {
    const h = harness(["s1", "s2"]);
    const pool = createPool({ size: 1, ttlMs: 60_000 }, h.deps);
    await pool.tick();
    h.healthy.add("s1");
    await pool.tick();

    h.clock.t += 61_000; // expire
    await pool.tick();
    assert.deepEqual(h.destroyed, ["s1"]);
    assert.deepEqual(h.booted, ["s1", "s2"]);
  });

  it("destroys warm standbys that stop answering health", async () => {
    const h = harness(["s1", "s2"]);
    const pool = createPool({ size: 1, ttlMs: 60_000 }, h.deps);
    await pool.tick();
    h.healthy.add("s1");
    await pool.tick();

    h.healthy.delete("s1"); // crashed / stopped elsewhere
    await pool.tick();
    assert.deepEqual(h.destroyed, ["s1"]);
    assert.deepEqual(h.booted, ["s1", "s2"], "replacement boots");
  });

  it("an assigned machine is never re-assigned or reaped — it left the pool", async () => {
    const h = harness(["s1", "s2"]);
    const pool = createPool({ size: 1, ttlMs: 60_000 }, h.deps);
    await pool.tick();
    h.healthy.add("s1");
    await pool.tick();
    assert.equal(pool.assign()?.name, "s1");
    assert.equal(pool.assign(), null, "assigned is gone from the pool");

    h.clock.t += 120_000; // the assigned machine ages past TTL — not our machine
    await pool.tick();
    assert.deepEqual(h.destroyed, [], "the pool forgot it at claim time — its own gate owns it now");
  });

  it("retries a failed destroy instead of orphaning the machine", async () => {
    const h = harness(["s1", "s2"]);
    let failing = true;
    h.deps.destroy = async (n) => {
      if (failing) throw new Error("platform error");
      h.destroyed.push(n);
    };
    const pool = createPool({ size: 1, ttlMs: 60_000 }, h.deps);
    await pool.tick();
    h.healthy.add("s1");
    await pool.tick();

    h.clock.t += 61_000; // expire — destroy fails
    await pool.tick();
    assert.deepEqual(h.destroyed, []);
    assert.equal(pool.tracked().length, 1, "still tracked: the retry owns it");
    assert.deepEqual(h.booted, ["s1"], "no replacement while the slot is occupied");

    failing = false;
    h.clock.t += 5_000;
    await pool.tick();
    assert.deepEqual(h.destroyed, ["s1"], "destroy retried and landed");
    assert.deepEqual(h.booted, ["s1", "s2"], "replacement boots after the slot frees");
  });

  it("adopts leftover standbys so a concierge restart never orphans them", async () => {
    const h = harness(["s3"]);
    const pool = createPool({ size: 1, ttlMs: 60_000 }, h.deps);
    pool.adopt(["s3"]); // found on the platform after our reboot
    h.healthy.add("s3");
    await pool.tick(); // promote + size satisfied → no new boot
    assert.deepEqual(h.booted, [], "the leftover IS the warm machine");
    assert.equal(pool.assign()?.name, "s3");

    // An unclaimed leftover gets reaped by TTL like any standby.
    const h2 = harness(["s4", "s5"]);
    const pool2 = createPool({ size: 1, ttlMs: 60_000 }, h2.deps);
    pool2.adopt(["s4"]);
    h2.healthy.add("s4");
    await pool2.tick();
    h2.clock.t += 61_000;
    await pool2.tick();
    assert.deepEqual(h2.destroyed, ["s4"], "adopted + unclaimed = reaped by TTL");
  });

  it("a failed boot is forgotten immediately", async () => {
    const h = harness();
    h.deps.boot = async () => {
      throw new Error("platform refused");
    };
    const pool = createPool({ size: 1, ttlMs: 60_000 }, h.deps);
    await pool.tick();
    assert.equal(pool.tracked().length, 0);
  });

  it("envInt falls back on garbage and floors low values", () => {
    process.env.TEST_POOL_X = "30s";
    assert.equal(envInt("TEST_POOL_X", 5_000), 5_000, "NaN → default");
    process.env.TEST_POOL_X = "0";
    assert.equal(envInt("TEST_POOL_X", 5_000, 1_000), 5_000, "below floor → default");
    process.env.TEST_POOL_X = "2500";
    assert.equal(envInt("TEST_POOL_X", 5_000), 2_500, "valid passes through");
    delete process.env.TEST_POOL_X;
    assert.equal(envInt("TEST_POOL_X", 5_000), 5_000, "unset → default");
  });

  it("standbyNameRe rejects metacharacters and non-members", () => {
    const re = standbyNameRe("waddle-standby-");
    assert.ok(re.test("waddle-standby-3"));
    assert.ok(!re.test("waddle-standby-3.attacker.tld"), "no dots (SSRF host escape)");
    assert.ok(!re.test("waddle-standby-host:8443"), "no ports");
    assert.ok(!re.test("waddle-standby-/../../etc"), "no path traversal");
    assert.ok(!re.test("waddle-standby-"), "bare prefix rejected");
    const weird = standbyNameRe("pre.fix-"); // metachar in the prefix itself
    assert.ok(weird.test("pre.fix-1"), "prefix metacharacters escaped, still matchable");
    assert.ok(!weird.test("preXfix-1"));
  });

  it("isUnclaimed: only a locked machine is pool property", () => {
    assert.equal(isUnclaimed({ locked: true }), true, "locked = blank standby");
    assert.equal(isUnclaimed({ locked: false }), false, "unlocked = someone's session");
    assert.equal(isUnclaimed(null), false, "no answer = not adoptable by this predicate");
  });
});
