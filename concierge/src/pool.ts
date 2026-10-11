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
 * replaced on a later tick. Foreign = a Running leftover adopted after
 * a concierge restart with unknown claim status: never assignable,
 * reaped on the claim-grace clock instead of the pool TTL.
 */
export interface PoolMachine {
  name: string;
  state: "booting" | "warm" | "destroying" | "foreign";
  createdAt: number;
}

export interface PoolDeps {
  /** Boot a fresh standby (create with the current tag + per-instance
   *  identity). Resolves when the platform accepts the request. */
  boot(name: string): Promise<void>;
  /** Stop and delete a standby. Idempotent. */
  destroy(name: string): Promise<void>;
  /** Health probe — true/false, or undefined when UNKNOWN this pass
   *  (platform list failure). Unknown must never read as dead: one
   *  `container list` blip would destroy every warm machine (I7). */
  health(name: string): Promise<boolean | undefined>;
  urlFor(name: string): string;
  /** Next standby name that doesn't collide with tracked machines. */
  nextName(): string;
  /** May the pool boot a new standby right now? (Release-window
   * deferral — see index.ts. Absent = always may.) */
  canFill?(): boolean;
  /** The instance's deployed tag (platform list; absent = unknown).
   *  With cfg.expectedTag set, warm stock on a stale tag is destroyed —
   *  a user handed a stale standby gets refused by their client's
   *  measurement pin (live-proven), so stale warmth is worthless. */
  tagOf?(name: string): Promise<string | undefined>;
  now(): number;
  log(msg: string, fields?: Record<string, unknown>): void;
}

export interface PoolConfig {
  /** Concurrent warm standbys to maintain. 0 disables the pool. */
  size: number;
  /** Unclaimed standbys older than this are destroyed. */
  ttlMs: number;
  /** Adopted Running leftovers (unknown claim status) are reaped on
   *  this clock — the claim bound, NOT the pool TTL: a machine a user
   *  unlocked may be mid-session, and claims outlive pool rows. */
  claimGraceMs?: number;
  /** The tag warm stock must carry (STANDBY_CONFIG_TAG). Machines on
   *  any other tag are reaped on tick — measurement-stale warmth serves
   *  no one (the client's pin refuses it). */
  expectedTag?: string;
}

export interface Pool {
  /** A user just used the service (/boot, /wake) — (re)arm warmth for
   *  the next TTL window. With no demand inside a TTL, the pool stays
   *  EMPTY (scale-to-0): idle time burns nothing but the concierge. */
  markDemand(): void;
  /** Milliseconds since the last service use (Infinity when never) —
   *  the /health signal for why the pool is empty (scale-to-0). */
  demandMsAgo(): number;
  /** Claim a warm standby for a user. Null when none is warm yet. */
  assign(): { name: string; url: string } | null;
  /** Maintenance pass — call on an interval. */
  tick(): Promise<void>;
  /** Track machines this process didn't create (leftovers found on the
   *  platform after our reboot). Adopted as booting with a fresh clock:
   *  health promotes them, the TTL reaps them if nobody claims — a
   *  concierge restart never orphans a billing standby. */
  adopt(names: string[]): void;
  /** Adopt RUNNING leftovers with unknown claim status: never
   *  assignable, reaped on the claim-grace clock instead of the TTL —
   *  a user may be mid-session on one. */
  adoptForeign(names: string[]): void;
  /** Names currently tracked (any state). */
  tracked(): PoolMachine[];
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
  // null = "never used since boot": a cold-started concierge fills
  // NOTHING until the first real /boot — scale-to-0 from first breath.
  let lastDemandAt: number | null = null;

  /** Condemn + destroy, retried by later ticks while it doesn't land.
   *  The entry is removed ONLY on a successful (or already-gone)
   *  destroy — a failed one keeps it tracked so the next tick retries
   *  instead of orphaning a billing machine nobody remembers. */
  async function destroyMachine(m: PoolMachine): Promise<void> {
    m.state = "destroying"; // synchronous: assign() must never hand out a machine mid-destroy
    try {
      await deps.destroy(m.name);
      machines.delete(m.name);
    } catch (e) {
      // A not-found destroy is success in every way that matters
      // (the machine is gone) — frees the slot.
      if (/not found|no such|already (been )?deleted/i.test(String(e))) {
        machines.delete(m.name);
        deps.log("destroy: machine already gone — slot freed", { name: m.name });
      } else {
        deps.log("destroy failed — retrying next tick", { name: m.name, err: String(e) });
      }
    }
  }

  async function tick(): Promise<void> {
    // 1. Reap. A destroy that didn't land stays condemned: retried
    //    every tick (health answers would not un-condemn it) — a stuck
    //    "destroying" entry used to linger un-retried until TTL.
    for (const m of live()) {
      if (m.state === "destroying") {
        await destroyMachine(m);
        continue;
      }
      // Foreign (adopted Running leftover, unknown claim status): never
      // assignable, reaped on the claim-grace clock — NOT the pool TTL,
      // because a claimed machine may legitimately be mid-session.
      if (m.state === "foreign") {
        if (deps.now() - m.createdAt > (cfg.claimGraceMs ?? 12 * 3600_000)) {
          deps.log("adopted running leftover past claim grace — destroying", { name: m.name, age_ms: deps.now() - m.createdAt });
          await destroyMachine(m);
        }
        continue;
      }
      const expired = deps.now() - m.createdAt > cfg.ttlMs;
      // UNKNOWN ≠ DEAD (I7): a failed status fetch skips the
      // health/tag reaps this pass — TTL still applies (it needs no
      // platform answer), but a blip can't destroy warm stock.
      const health = await deps.health(m.name).catch(() => undefined);
      const dead = m.state === "warm" && health === false;
      let staleTag = false;
      if (cfg.expectedTag && m.state !== "booting" && deps.tagOf && health !== undefined) {
        const tag = await deps.tagOf(m.name).catch(() => undefined);
        staleTag = tag !== undefined && tag !== cfg.expectedTag;
      }
      if (expired || dead || staleTag) {
        deps.log(
          expired ? "standby ttl expired — destroying" : dead ? "warm standby unhealthy — destroying" : "standby tag stale — destroying (measurement pin would refuse it)",
          { name: m.name, age_ms: deps.now() - m.createdAt },
        );
        await destroyMachine(m);
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
    //    DEMAND-GATED (scale-to-0): warmth exists only for users who
    //    might arrive — the TTL window after the last real use. Past
    //    that, the pool stays empty until the next /boot pays the cold
    //    mint and re-arms it. Deferred while a handoff release window
    //    is open: a replacement boot racing the intended schedule-boot's
    //    one-shot pull is the standby-steal path (SME review) — warm one
    //    tick later instead.
    // Foreign machines don't count toward the fill budget: they're
    // adopted burn on the claim-grace clock, not warmth — users still
    // get their standby (temporary over-burn, bounded by the grace).
    const warmthArmed = lastDemandAt !== null && deps.now() - lastDemandAt <= cfg.ttlMs;
    const warmable = live().filter((m) => m.state !== "foreign").length;
    if (cfg.size > 0 && warmthArmed && warmable < cfg.size && (deps.canFill?.() ?? true)) {
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

  /** Adopt Running leftovers whose claim status died with a restart.
   *  NEVER assignable (assign() hands out warm only): a Running
   *  standby may be a machine a user already claimed via /boot and
   *  unlocked — handing its URL to a second user, or TTL-deleting it
   *  mid-session, would violate the claim. Reaped on the claim-grace
   *  clock instead (review finding). */
  function adoptForeign(names: string[]): void {
    for (const name of names) {
      if (machines.has(name)) continue;
      machines.set(name, { name, state: "foreign", createdAt: deps.now() });
      deps.log("running leftover adopted as foreign (never assignable; claim-grace reaped)", { name });
    }
  }

  return {
    markDemand: () => {
      lastDemandAt = deps.now();
    },
    demandMsAgo: () => (lastDemandAt === null ? Infinity : deps.now() - lastDemandAt),
    assign,
    tick,
    adopt,
    adoptForeign,
    tracked: () => [...machines.values()],
  };
}
