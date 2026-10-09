/**
 * @waddle/concierge — the warm-standby pool.
 *
 * The product shape: N blank, locked, env-inferred machines booted and
 * waiting. A user arrival claims one (assignment is a URL handout — their
 * secret makes it theirs); a replacement boots behind their session.
 * Unclaimed standbys are dropped after a TTL so idle time can't burn an
 * unbounded budget. The pool knows names, states, and timings — never
 * secrets, never user data. All platform verbs are injected.
 *
 * States: booting → warm → (assigned: leaves the pool — its own gate,
 * stop rows, and the client own it from there). A booting machine that
 * never turns healthy, a warm machine that dies, or any machine past the
 * TTL is stopped-and-deleted (retried until the destroy lands) and
 * replaced on a later tick.
 */
export interface PoolMachine {
  name: string;
  state: "booting" | "warm";
  createdAt: number;
}

export interface PoolDeps {
  /** Boot a fresh standby (create with the current tag + per-instance
   *  identity). Resolves when the platform accepts the request. */
  boot(name: string): Promise<void>;
  /** Stop and delete a standby. Idempotent. */
  destroy(name: string): Promise<void>;
  /** Plain health probe — true iff the machine answers. */
  health(name: string): Promise<boolean>;
  urlFor(name: string): string;
  /** Next standby name that doesn't collide with tracked machines. */
  nextName(): string;
  now(): number;
  log(msg: string, fields?: Record<string, unknown>): void;
}

export interface PoolConfig {
  /** Concurrent warm standbys to maintain. 0 disables the pool. */
  size: number;
  /** Unclaimed standbys older than this are destroyed. */
  ttlMs: number;
}

export interface Pool {
  /** Claim a warm standby for a user. Null when none is warm yet. */
  assign(): { name: string; url: string } | null;
  /** Maintenance pass — call on an interval. */
  tick(): Promise<void>;
  /** Track machines this process didn't create (leftovers found on the
   *  platform after our reboot). Adopted as booting with a fresh clock:
   *  health promotes them, the TTL reaps them if nobody claims — a
   *  concierge restart never orphans a billing standby. */
  adopt(names: string[]): void;
  /** Names currently tracked (any state). */
  tracked(): PoolMachine[];
}

/** A leftover standby is adoptable ONLY while still locked (blank). One
 *  reporting locked:false was claimed by a user — the pool must never
 *  re-assign or reap a machine that is somebody's session. */
export function isUnclaimed(health: { locked?: boolean } | null): boolean {
  return health?.locked === true;
}

/** Parse an int env var with a floor; malformed values fall back to the
 *  default — a NaN interval would hot-loop and a NaN TTL would silently
 *  disable the budget cap the pool exists to enforce. (In pool.ts so the
 *  parsing is unit-tested; index.ts imports it.) */
export function envInt(name: string, def: number, floor = 1): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < floor) return def;
  return Math.floor(n);
}

/** Standby names are strictly `<prefix><digits>` — no URL/CLI
 *  metacharacters can ride an instance name into a probe URL or a
 *  platform verb. */
export function standbyNameRe(prefix: string): RegExp {
  return new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\d+$`);
}

export function createPool(cfg: PoolConfig, deps: PoolDeps): Pool {
  const machines = new Map<string, PoolMachine>();
  const live = (): PoolMachine[] => [...machines.values()];

  async function tick(): Promise<void> {
    // 1. Reap: TTL-expired or dead machines get destroyed. The entry is
    //    removed ONLY on a successful destroy — a failed one leaves it
    //    tracked so the next tick retries instead of orphaning a
    //    billing machine nobody remembers.
    for (const m of live()) {
      const expired = deps.now() - m.createdAt > cfg.ttlMs;
      const dead = m.state === "warm" && !(await deps.health(m.name).catch(() => false));
      if (expired || dead) {
        deps.log(expired ? "standby ttl expired — destroying" : "warm standby unhealthy — destroying", { name: m.name, age_ms: deps.now() - m.createdAt });
        try {
          await deps.destroy(m.name);
          machines.delete(m.name);
        } catch (e) {
          deps.log("destroy failed — retrying next tick", { name: m.name, err: String(e) });
        }
        continue;
      }
    }
    // 2. Promote: a booting machine that answers health is warm.
    for (const m of live()) {
      if (m.state !== "booting") continue;
      if (await deps.health(m.name).catch(() => false)) {
        m.state = "warm";
        deps.log("standby warm", { name: m.name, boot_ms: deps.now() - m.createdAt });
      }
    }
    // 3. Fill: one boot per tick — size>1 warms gradually, never bursts.
    if (cfg.size > 0 && live().length < cfg.size) {
      const name = deps.nextName();
      machines.set(name, { name, state: "booting", createdAt: deps.now() });
      try {
        await deps.boot(name);
        deps.log("standby booting", { name });
      } catch (e) {
        machines.delete(name);
        deps.log("boot failed", { name, err: String(e) });
      }
    }
  }

  function assign(): { name: string; url: string } | null {
    const warm = live().find((m) => m.state === "warm");
    if (!warm) return null;
    deps.log("standby assigned", { name: warm.name });
    const got = { name: warm.name, url: deps.urlFor(warm.name) };
    // Claimed machines leave the pool entirely: their own gate, stop
    // rows, and the client own them now. (The name stays burned in the
    // caller's collision set — a live machine may still hold it.)
    machines.delete(warm.name);
    return got;
  }

  function adopt(names: string[]): void {
    for (const name of names) {
      if (machines.has(name)) continue;
      machines.set(name, { name, state: "booting", createdAt: deps.now() });
      deps.log("standby adopted (leftover from a previous run)", { name });
    }
  }

  return {
    assign,
    tick,
    adopt,
    tracked: () => [...machines.values()],
  };
}
