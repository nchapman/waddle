import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPool, envInt, standbyNameRe, type PoolDeps } from "./pool.js";

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
    pool.markDemand();
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

  it("destroys TTL-expired standbys — with no further use the pool scales to 0", async () => {
    const h = harness(["s1", "s2"]);
    const pool = createPool({ size: 1, ttlMs: 60_000 }, h.deps);
    pool.markDemand();
    await pool.tick();
    h.healthy.add("s1");
    await pool.tick();

    h.clock.t += 61_000; // expire — and nobody has used the service since
    await pool.tick();
    assert.deepEqual(h.destroyed, ["s1"]);
    assert.deepEqual(h.booted, ["s1"], "no replacement: idle past the TTL = scale-to-0");
    assert.equal(pool.tracked().length, 0);
    assert.equal(pool.demandMsAgo(), 61_000);

    await pool.tick(); // and it STAYS empty
    assert.deepEqual(h.booted, ["s1"]);
  });

  it("replaces TTL-expired standbys while the service is in use", async () => {
    const h = harness(["s1", "s2"]);
    const pool = createPool({ size: 1, ttlMs: 60_000 }, h.deps);
    pool.markDemand();
    await pool.tick();
    h.healthy.add("s1");
    await pool.tick();

    h.clock.t += 61_000; // expire
    pool.markDemand(); // …but a /boot just happened — warmth is armed
    await pool.tick();
    assert.deepEqual(h.destroyed, ["s1"]);
    assert.deepEqual(h.booted, ["s1", "s2"], "in-use service keeps a warm standby");
  });

  it("a cold-started pool fills nothing until first use (scale-to-0 from boot)", async () => {
    const h = harness(["s1"]);
    const pool = createPool({ size: 1, ttlMs: 60_000 }, h.deps);
    await pool.tick();
    await pool.tick();
    assert.deepEqual(h.booted, [], "never used → never warm");
    assert.equal(pool.demandMsAgo(), Infinity);

    pool.markDemand();
    await pool.tick();
    assert.deepEqual(h.booted, ["s1"], "first /boot arms warmth for the next arrival");
  });

  it("destroys warm standbys that stop answering health", async () => {
    const h = harness(["s1", "s2"]);
    const pool = createPool({ size: 1, ttlMs: 60_000 }, h.deps);
    pool.markDemand();
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
    pool.markDemand();
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
    pool.markDemand();
    await pool.tick();
    h.healthy.add("s1");
    await pool.tick();

    h.clock.t += 61_000; // expire — destroy fails
    pool.markDemand(); // service in use throughout
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

  it("retries a failed destroy on a HEALTH-DEAD warm standby (stuck destroying is re-condemned every tick)", async () => {
    const h = harness(["s1", "s2"]);
    let failing = true;
    h.deps.destroy = async (n) => {
      if (failing) throw new Error("platform error");
      h.destroyed.push(n);
    };
    const pool = createPool({ size: 1, ttlMs: 60_000 }, h.deps);
    pool.markDemand();
    await pool.tick();
    h.healthy.add("s1");
    await pool.tick(); // warm

    h.healthy.delete("s1"); // dies — destroy fails, state sticks at destroying
    await pool.tick();
    assert.deepEqual(h.destroyed, []);

    // Well before TTL: the stuck destroying entry must still be retried
    // (it used to fall out of the reap predicate entirely).
    h.clock.t += 5_000;
    await pool.tick();
    assert.deepEqual(h.destroyed, [], "first retry also fails");

    failing = false;
    h.clock.t += 5_000;
    await pool.tick();
    assert.deepEqual(h.destroyed, ["s1"], "health-death destroy retried without waiting for TTL");
  });

  it("foreign (adopted Running) leftovers are never assignable and outlive the pool TTL", async () => {
    const h = harness(["s1", "s2"]);
    h.deps.destroy = async (n) => {
      h.destroyed.push(n);
    };
    const pool = createPool({ size: 1, ttlMs: 60_000, claimGraceMs: 600_000 }, h.deps);
    pool.markDemand();
    pool.adoptForeign(["standby-9"]);
    assert.equal(pool.assign(), null, "foreign is never warm → never assignable");

    h.clock.t += 61_000; // past the pool TTL — the claim grace still holds
    pool.markDemand(); // service in use — warmth stays armed
    await pool.tick();
    assert.deepEqual(h.destroyed, [], "NOT TTL-reaped: a user may be mid-session");
    assert.deepEqual(h.booted, ["s1"], "foreign does not consume the fill budget");

    h.healthy.add("s1");
    await pool.tick();
    const got = pool.assign();
    assert.equal(got?.name, "s1", "warm standby still assignable alongside foreign");

    h.clock.t += 600_000; // claim grace elapses
    await pool.tick();
    assert.deepEqual(h.destroyed, ["standby-9"], "reaped on the claim-grace clock");
  });

  it("defers fills while canFill() is false (release-window deferral) and boots one tick later", async () => {
    const h = harness(["s1"]);
    let mayFill = false;
    h.deps.canFill = () => mayFill;
    const pool = createPool({ size: 1, ttlMs: 60_000 }, h.deps);
    pool.markDemand();
    await pool.tick();
    assert.deepEqual(h.booted, [], "no boot while the release window is open");

    mayFill = true;
    await pool.tick();
    assert.deepEqual(h.booted, ["s1"], "fills resume the tick after the window closes");
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
    pool.markDemand(); // arm warmth so the boot is actually attempted
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

});

it("tick destroys warm stock on a stale tag — the client's measurement pin would refuse it", async () => {
  const destroyed: string[] = [];
  let n = 0;
  const pool = createPool({ size: 1, ttlMs: 60_000, expectedTag: "v1.0.0" }, {
    boot: async () => { n++; },
    destroy: async (name) => { destroyed.push(name); },
    health: async () => true,
    urlFor: (name) => `https://${name}.x`,
    nextName: () => `waddle-standby-${++n}`,
    tagOf: async () => "v9.9.9", // everything stale
    now: () => Date.now(),
    log: () => undefined,
  });
  pool.markDemand();
  await pool.tick(); // booting
  await pool.tick(); // warm (health true)
  await pool.tick(); // stale-tag reap (+ refill boot)
  assert.ok(destroyed.length >= 1, "stale warm stock destroyed");
});

it("tick keeps warm stock whose tag matches expectedTag", async () => {
  const destroyed: string[] = [];
  let n = 0;
  const pool = createPool({ size: 1, ttlMs: 60_000, expectedTag: "v1.0.0" }, {
    boot: async () => { n++; },
    destroy: async (name) => { destroyed.push(name); },
    health: async () => true,
    urlFor: (name) => `https://${name}.x`,
    nextName: () => `waddle-standby-${++n}`,
    tagOf: async () => "v1.0.0", // fresh
    now: () => Date.now(),
    log: () => undefined,
  });
  pool.markDemand(); // arm warmth so stock actually exists to keep
  await pool.tick(); await pool.tick(); await pool.tick();
  assert.equal(destroyed.length, 0);
  assert.equal(pool.tracked().length, 1, "warm stock alive, not vacuously empty");
});
