/**
 * @waddle/concierge — the always-on, deliberately dumb lifecycle timer.
 *
 * One primitive: a table of rows {instance, action, due}. Writers replace
 * rows; timers fire verbs. All intelligence lives in the agents, expressed
 * as table writes:
 *
 *   activity      → agent replaces its stop row (idle backstop, idle+margin)
 *   death flare   → agent at exit replaces its stop row with ~now+5s
 *                   (its own checkpoint-exit already happened; this is the
 *                   platform-level stop that ends billing + zombie state)
 *   scheduled work→ agent writes a wake row (one-shot, job-keyed)
 *   user appears  → client calls the one immediate verb: /wake
 *
 * Memory-only by design: a reboot wipes every row and every session token
 * (death is the strongest revocation). Clients/agents heal by
 * re-handshaking on their next boot. The backstop sweep stops MANAGED
 * instances (CONCIERGE_ALLOWED_INSTANCES — the operator's waddle names,
 * never the whole host/account) that went silent for HARD_STOP_MS — that
 * also covers our own amnesia after a reboot.
 *
 * Compromise costs availability and money, never confidentiality: a fresh
 * boot sits at its lock screen. Egress belongs on the controlplane (plus
 * JWKS for auth) — the container config enforces it, this code assumes it.
 */
import fastify from "fastify";
import cors from "@fastify/cors";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createTable } from "./table.js";
import { createPool, envInt, standbyNameRe, isUnclaimed, type Pool } from "./pool.js";

const exec = promisify(execFile);

const PORT = Number(process.env.CONCIERGE_PORT ?? 8081);
const JWKS_URL = process.env.CONCIERGE_JWKS_URL ?? "";
const ISSUER = process.env.CONCIERGE_ISSUER ?? "";
const AUDIENCE = process.env.CONCIERGE_AUDIENCE ?? "";
/** docker | tinfoil — config-selected backend (seam, not code fork). */
const BACKEND = process.env.CONCIERGE_BACKEND ?? "docker";
/** Hard backstop: stop managed instances silent longer than this. */
const HARD_STOP_MS = Number(process.env.CONCIERGE_HARD_STOP_MS ?? 24 * 3600_000);
/** Dev stand-in shared secret when JWKS isn't configured. */
const SHARED_SECRET = process.env.CONCIERGE_TOKEN;
/** The instances this concierge may touch, ever. Anything else on the
 *  platform — other containers, other accounts' work — is invisible. */
const ALLOWED = new Set(
  (process.env.CONCIERGE_ALLOWED_INSTANCES ?? "waddle")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

const jwks = JWKS_URL ? createRemoteJWKSet(new URL(JWKS_URL)) : null;
if (jwks && !AUDIENCE) {
  console.warn("[concierge] CONCIERGE_AUDIENCE is empty: JWTs are verified for signature/issuer only. Pin the betterbase audience before trusting this in prod.");
}

// ── Warm-standby pool (tinfoil backend only) ───────────────────────────
const POOL_SIZE = envInt("WARM_POOL_SIZE", 0, 0);
const STANDBY_TTL_MS = envInt("STANDBY_TTL_MS", 3_600_000, 1_000);
const STANDBY_PREFIX = process.env.STANDBY_PREFIX ?? "waddle-standby-";
const STANDBY_CONFIG_REPO = process.env.STANDBY_CONFIG_REPO ?? "";
const STANDBY_CONFIG_TAG = process.env.STANDBY_CONFIG_TAG ?? "";
const STANDBY_SECRETS = (process.env.STANDBY_SECRETS ?? "CONCIERGE_SHARED_SECRET,TINFOIL_API_KEY")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
/** Standby idle gate: longer than the pool TTL so the POOL owns unclaimed
 *  standbys (TTL reap), not the machine's own locked-boot backstop — a
 *  10.5-min self-destruct would churn every slot ~6x the budget. Once
 *  claimed + unlocked, activity renews past it like any machine. */
const STANDBY_IDLE_MS = envInt("STANDBY_IDLE_MS", STANDBY_TTL_MS + 15 * 60_000, 60_000);
/** https://<instance>.<INSTANCE_DOMAIN_BASE> — URLs + health probes. */
const DOMAIN_BASE = process.env.INSTANCE_DOMAIN_BASE ?? "";
const POOL_CAPABLE = BACKEND === "tinfoil" && !!STANDBY_CONFIG_REPO && !!STANDBY_CONFIG_TAG && !!DOMAIN_BASE;
if (POOL_SIZE > 0 && !POOL_CAPABLE) {
  console.warn("[concierge] WARM_POOL_SIZE set but pool needs BACKEND=tinfoil, STANDBY_CONFIG_REPO, STANDBY_CONFIG_TAG, INSTANCE_DOMAIN_BASE — pool stays off");
}
const POOL_ENABLED = POOL_SIZE > 0 && POOL_CAPABLE;
const STANDBY_NAME_RE = standbyNameRe(STANDBY_PREFIX);

// ── Platform verbs (backends are ~25 lines each by design) ───────────────

async function startInstance(instance: string): Promise<string> {
  if (BACKEND === "docker") {
    await exec("docker", ["start", instance]);
    return `docker:${instance} started`;
  }
  // tinfoil: deploy boots a stopped instance with its measured config.
  // Needs the CLI on PATH + TINFOIL_ADMIN_KEY in env (container build
  // concern — see the Dockerfile).
  try {
    const { stdout } = await exec("tinfoil", ["container", "deploy", instance], { timeout: 120_000 });
    return stdout.trim().split("\n").slice(-3).join(" | ");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Zombie: the agent idle-exited but the instance still reads Running —
    // deploy 409s. Stop, wait it out, deploy. (Live-verified sequence; a
    // same-tag update also works but needs the tag to exist.)
    if (msg.includes("cannot deploy a running instance")) {
      await restInstance(instance);
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 2_000));
        try {
          const { stdout } = await exec("tinfoil", ["container", "deploy", instance], { timeout: 120_000 });
          return "(zombie recovered) " + stdout.trim().split("\n").slice(-2).join(" | ");
        } catch (retry) {
          const m = retry instanceof Error ? retry.message : String(retry);
          if (!m.includes("cannot deploy a running instance") && !m.includes("update is already in progress")) throw retry;
        }
      }
      throw new Error("zombie instance would not accept a deploy after stop");
    }
    throw e;
  }
}

async function restInstance(instance: string): Promise<string> {
  if (BACKEND === "docker") {
    await exec("docker", ["stop", instance], { timeout: 120_000 });
    return `docker:${instance} stopped`;
  }
  try {
    const { stdout } = await exec("tinfoil", ["container", "stop", instance], { timeout: 120_000 });
    return stdout.trim().split("\n").slice(-3).join(" | ");
  } catch (e) {
    // Already stopped (or stopping) is success for an idempotent stop.
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("is not running") || msg.includes("already")) return `already stopped: ${instance}`;
    throw e;
  }
}

async function listInstances(): Promise<string[]> {
  if (BACKEND === "docker") {
    const { stdout } = await exec("docker", ["ps", "-a", "--format", "{{.Names}}"]);
    return stdout.split("\n").map((s) => s.trim()).filter((n): n is string => Boolean(n));
  }
  const { stdout } = await exec("tinfoil", ["container", "list"], { timeout: 60_000 });
  // Header row then one row per instance; the name is the first column.
  return stdout
    .split("\n")
    .slice(1)
    .map((l) => l.trim().split(/\s+/)[0])
    .flatMap((n) => (typeof n === "string" && n && !n.startsWith("NAME") ? [n] : []));
}

/** Plain health probe — no attestation needed for "is it up" (the
 *  client's SecureClient does the real verification). */
async function instanceHealth(instance: string): Promise<{ locked?: boolean } | null> {
  if (!DOMAIN_BASE) return null;
  try {
    const res = await fetch(`https://${instance}.${DOMAIN_BASE}/health`, { signal: AbortSignal.timeout(4_000) });
    return res.ok ? ((await res.json()) as { locked?: boolean }) : null;
  } catch {
    return null;
  }
}

async function instanceHealthy(instance: string): Promise<boolean> {
  return (await instanceHealth(instance)) !== null;
}

/** Health-first start: a machine that already answers (dozing, live, or
 *  a warm standby the wake row targeted) needs nothing — the old path
 *  would have run the zombie stop-deploy dance on a healthy machine. */
async function ensureInstance(instance: string): Promise<string> {
  if (BACKEND === "tinfoil" && (await instanceHealthy(instance))) {
    return `already running: ${instance}`;
  }
  return startInstance(instance);
}

// ── The table (semantics live in table.ts; platform verbs fire here) ─────

const app = fastify({ logger: true });

const table = createTable(
  (instance) => {
    void restInstance(instance)
      .then((detail) => app.log.info({ instance, detail }, "stop row fired"))
      .catch((e) => app.log.warn({ instance, err: String(e) }, "stop row fired but failed"));
  },
  (instance, jobId) => {
    void ensureInstance(instance)
      .then((detail) => app.log.info({ instance, jobId, detail }, "wake row fired"))
      .catch((e) => app.log.warn({ instance, jobId, err: String(e) }, "wake row fired but failed"));
  },
);

// ── Auth ─────────────────────────────────────────────────────────────────

/** Verify a betterbase JWT (client path) or the dev shared secret. */
async function verifyExternal(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  if (jwks) {
    try {
      await jwtVerify(token, jwks, { issuer: ISSUER || undefined, audience: AUDIENCE || undefined });
      return true;
    } catch {
      return false;
    }
  }
  return SHARED_SECRET ? token === SHARED_SECRET : false;
}

function allowedInstance(instance: string | undefined): instance is string {
  if (typeof instance !== "string") return false;
  if (ALLOWED.has(instance)) return true;
  // Standby namespace: strict shape AND a name this process created or
  // adopted — a bare prefix match would let any token holder mint rows
  // against operator-invisible instances (and grow the table unbounded).
  return POOL_ENABLED && STANDBY_NAME_RE.test(instance) && poolNames.has(instance);
}

/** Session tokens: handshake-minted, instance-scoped, memory-only. */
async function authorize(req: { headers: { authorization?: string }; body?: { instance?: string } }): Promise<string | null> {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const instance = req.body?.instance;
  if (!token || !allowedInstance(instance)) return null;
  const e = table.entry(instance);
  if (e && token === e.sessionToken) {
    e.lastContact = Date.now();
    return instance;
  }
  // Fall through to external auth (client JWT / dev secret) — then bind to
  // the instance's entry so both callers share one table.
  if (await verifyExternal(token)) return instance;
  return null;
}

// ── Service ──────────────────────────────────────────────────────────────

await app.register(cors, {
  origin: (process.env.CONCIERGE_ALLOWED_ORIGINS ?? "http://localhost:5173").split(","),
});

app.get("/health", async () => ({
  service: "waddle-concierge",
  version: "0.3.0",
  backend: BACKEND,
  rows: table.countRows(),
  // Counts only — standby NAMES authorize the standby namespace in
  // allowedInstance, so they are not published unauthenticated.
  pool: pool ? { size: POOL_SIZE, ttl_ms: STANDBY_TTL_MS, tracked: pool.tracked().length } : { size: 0 },
}));

/** Assign a warm standby: URL handout, nothing more — the user's secret
 *  is what makes the machine theirs. The replacement boot hides behind
 *  the user's session (pool tick). */
app.get("/assign", async (req, reply) => {
  if (!POOL_ENABLED || !pool) return reply.code(404).send({ error: "pool disabled" });
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!(await verifyExternal(token))) return reply.code(401).send({ error: "unauthorized" });
  const got = pool.assign();
  if (!got) return reply.code(404).send({ error: "no warm standby — use /wake" });
  // A claim is bounded presence, not ownership: REPLACE the machine's
  // boot-time stop row with a grace row. If the user unlocks, renewIdleStop
  // re-arms it from activity like any machine; if they abandon the claim
  // (closed tab at the lock screen), the machine dies within grace — the
  // next scan adopts the stopped blank and the TTL reclaims the slot. No
  // path leaves a claimed machine billing for HARD_STOP_MS.
  table.setStop(got.name, envInt("STANDBY_CLAIM_GRACE_MS", 15 * 60_000, 30_000));
  void pool.tick().catch(() => undefined); // top the pool back up promptly
  return got;
});

/** Handshake: betterbase JWT (or dev secret) → session token. Once per
 *  agent boot; re-running replaces the token (idempotent). */
app.post<{ Body: { instance?: string } }>("/handshake", async (req, reply) => {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const { instance } = req.body ?? {};
  if (!allowedInstance(instance)) return reply.code(403).send({ error: "instance not allowed" });
  if (!(await verifyExternal(token))) return reply.code(401).send({ error: "unauthorized" });
  const { sessionToken } = table.mintSession(instance);
  return { session_token: sessionToken };
});

/** The table write. Replace semantics ARE the policy:
 *  stop rows are singleton-per-instance (debounce), wake rows are
 *  job-keyed one-shots. due_ms is relative (skew-immune); 0 cancels. */
app.post<{
  Body: { instance?: string; action?: "stop" | "wake"; due_ms?: number; job_id?: string };
}>("/timer", async (req, reply) => {
  const instance = await authorize(req);
  if (!instance) return reply.code(401).send({ error: "unauthorized" });
  const { action, due_ms, job_id } = req.body ?? {};
  if (action !== "stop" && action !== "wake") return reply.code(400).send({ error: "action must be stop|wake" });
  if (typeof due_ms !== "number" || due_ms < 0) return reply.code(400).send({ error: "due_ms (ms from now, 0 to cancel) required" });

  if (action === "stop") {
    return { ok: true, stop: table.setStop(instance, due_ms) };
  }
  if (!job_id) return reply.code(400).send({ error: "job_id required for wake rows" });
  return { ok: true, wake: table.setWake(instance, job_id, due_ms), job_id };
});

/** The one immediate verb — the client's "user came online" path. */
app.post<{ Body: { instance?: string } }>("/wake", async (req, reply) => {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const { instance } = req.body ?? {};
  if (!allowedInstance(instance)) return reply.code(403).send({ error: "instance not allowed" });
  if (!(await verifyExternal(token))) return reply.code(401).send({ error: "unauthorized" });
  // A user present means the machine should live: clear any pending stop.
  table.userWake(instance);
  try {
    const detail = await ensureInstance(instance);
    return reply.code(202).send({ status: "waking", detail });
  } catch (err) {
    return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** Operator/debug: the table, no secrets. */
app.get("/status", async () => ({ now: Date.now(), instances: table.snapshot() }));

// ── The pool (module semantics in pool.ts; platform verbs here) ───────

/** Names the pool must never collide with: seeded from the platform
 *  (our memory is wiped on reboot — leftover standbys exist) and grown as
 *  we create. Also the authority for the standby namespace —
 *  allowedInstance accepts only names it contains. */
const poolNames = new Set<string>();
const pool: Pool | null = POOL_CAPABLE
  ? createPool(
      { size: POOL_ENABLED ? POOL_SIZE : 0, ttlMs: STANDBY_TTL_MS },
      {
        boot: async (name) => {
          poolNames.add(name); // burn the name even on failure — a colliding
          // create must not wedge nextName on the same index forever
          const args = [
            "container", "create", name,
            "--repo", STANDBY_CONFIG_REPO,
            "--tag", STANDBY_CONFIG_TAG,
            "--variable", `WADDLE_INSTANCE=${name}`,
            "--variable", `WADDLE_IDLE_MS=${STANDBY_IDLE_MS}`,
            "--no-wait",
          ];
          for (const s of STANDBY_SECRETS) args.push("--secret", s);
          await exec("tinfoil", args, { timeout: 30_000 });
        },
        destroy: async (name) => {
          await restInstance(name);
          await exec("tinfoil", ["container", "delete", name], { timeout: 60_000 });
          // The machine is gone: free the name. Recycling keeps the standby
          // namespace tiny (standby-1, standby-2…) so the operator's egress
          // allowlist can name every possible probe host exactly.
          poolNames.delete(name);
        },
        health: instanceHealthy,
        urlFor: (name) => `https://${name}.${DOMAIN_BASE}`,
        nextName: () => {
          for (let i = 1; ; i++) {
            const n = `${STANDBY_PREFIX}${i}`;
            if (!poolNames.has(n)) return n;
          }
        },
        now: () => Date.now(),
        log: (msg, fields) => app.log.info(fields ?? {}, msg),
      },
    )
  : null;
if (pool) {
  /** Leftover scan: adopt UNCLAIMED standbys found on the platform (a
   *  concierge restart must never orphan a billing machine — nor adopt a
   *  machine a user already claimed: locked = blank, unlocked = live
   *  session that the pool must not touch). Runs at boot and
   *  periodically — a failed scan retries instead of waiting for the
   *  next process restart. */
  const scanLeftovers = () =>
    listInstances()
      .then(async (names) => {
        const leftovers: string[] = [];
        for (const n of names) {
          if (!STANDBY_NAME_RE.test(n) || poolNames.has(n)) continue;
          poolNames.add(n);
          const h = await instanceHealth(n);
          if (h === null || isUnclaimed(h)) {
            // stopped/dead or still-locked (blank): pool property — adopt
            leftovers.push(n);
          } else {
            app.log.info({ name: n }, "pool: leftover is claimed (unlocked) — left alone");
          }
        }
        if (leftovers.length > 0) pool.adopt(leftovers);
        app.log.info({ adopted: leftovers.length }, "pool: platform standby scan");
        void pool.tick();
      })
      .catch((e) => app.log.warn({ err: String(e) }, "pool scan failed — retrying next interval"));
  void scanLeftovers();
  setInterval(() => void scanLeftovers(), envInt("POOL_SCAN_MS", 5 * 60_000, 10_000)).unref();
  if (POOL_ENABLED) {
    setInterval(() => void pool.tick().catch((e) => app.log.warn({ err: String(e) }, "pool tick failed")), envInt("POOL_TICK_MS", 30_000, 1_000)).unref();
  }
}

// ── Backstop sweep: managed instances gone quiet get stopped ─────────────
// Covers missed death-flares and our own post-reboot amnesia. Scoped to
// ALLOWED — never the whole docker host or platform account.
setInterval(
  () => {
    void (async () => {
      const names = await listInstances().catch((e) => {
        app.log.warn({ err: String(e) }, "backstop list failed");
        return [] as string[];
      });
      for (const name of names) {
        if (!allowedInstance(name)) continue;
        const e = table.entry(name);
        // Only reap what we've SEEN go quiet: an unseen instance may belong
        // to a session that predates our reboot (memory wipe) — its own idle
        // gate + the client's re-handshake own that healing, not a blind stop.
        if (!e) continue;
        const quietMs = Date.now() - e.lastContact;
        if (quietMs < HARD_STOP_MS) continue;
        app.log.info({ instance: name, quiet_ms: quietMs }, "backstop: stopping silent managed instance");
        await restInstance(name).catch(() => undefined);
      }
    })();
  },
  Number(process.env.CONCIERGE_SWEEP_MS ?? 15 * 60_000),
).unref();

await app.listen({ port: PORT, host: "0.0.0.0" });
