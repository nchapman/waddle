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
import { timingSafeEqual } from "node:crypto";
import { createTable } from "./table.js";
import { createHandoffStore } from "./handoff.js";
import { createPool, envInt, standbyNameRe, type Pool } from "./pool.js";

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
/** https://<instance>.<INSTANCE_DOMAIN_BASE> — URLs + health probes. */
const DOMAIN_BASE = process.env.INSTANCE_DOMAIN_BASE ?? "";
const POOL_CAPABLE = BACKEND === "tinfoil" && !!STANDBY_CONFIG_REPO && !!STANDBY_CONFIG_TAG && !!DOMAIN_BASE;
if (POOL_SIZE > 0 && !POOL_CAPABLE) {
  console.warn("[concierge] WARM_POOL_SIZE set but pool needs BACKEND=tinfoil, STANDBY_CONFIG_REPO, STANDBY_CONFIG_TAG, INSTANCE_DOMAIN_BASE — pool stays off");
}
const POOL_ENABLED = POOL_SIZE > 0 && POOL_CAPABLE;
const STANDBY_NAME_RE = standbyNameRe(STANDBY_PREFIX);

// ── Platform verbs (backends are ~25 lines each by design) ───────────────

/** The tag every deploy boots — the pool's tag by default, so /wake and
 * standby creates can never skew from what the client verifies (latest
 * release of the config repo). */
const DEPLOY_TAG = process.env.CONCIERGE_DEPLOY_TAG ?? (POOL_CAPABLE ? STANDBY_CONFIG_TAG : "");

async function startInstance(instance: string): Promise<string> {
  if (BACKEND === "docker") {
    await exec("docker", ["start", instance]);
    return `docker:${instance} started`;
  }
  // tinfoil: deploy boots a stopped instance with its measured config.
  // Needs the CLI on PATH + TINFOIL_ADMIN_KEY in env (container build
  // concern — see the Dockerfile). Deploy WITH the configured tag: a
  // tagless deploy re-boots the instance's SAVED tag — version skew the
  // client's latest-release verification correctly refuses.
  const deployArgs = (instance: string) =>
    DEPLOY_TAG ? ["container", "deploy", instance, "--tag", DEPLOY_TAG] : ["container", "deploy", instance];
  try {
    const { stdout } = await exec("tinfoil", deployArgs(instance), { timeout: 120_000 });
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
          const { stdout } = await exec("tinfoil", deployArgs(instance), { timeout: 120_000 });
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

/** Platform status by instance name, memoized briefly — the pool and the
 *  leftover scan share one `container list` per tick. Health of a standby
 *  = "Running" (the control plane is the only egress the concierge needs
 *  — probing machine URLs would require allowlisting hostnames that don't
 *  exist until the machines do, and the allowlist pins IPs at boot). */
let statusCache: { at: number; map: Map<string, string> } | null = null;
async function instanceStatuses(): Promise<Map<string, string>> {
  if (statusCache && Date.now() - statusCache.at < 10_000) return statusCache.map;
  const { stdout } = await exec("tinfoil", ["container", "list"], { timeout: 60_000 });
  const map = new Map<string, string>();
  for (const line of stdout.split("\n").slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length >= 2 && cols[0] && cols[0] !== "NAME") map.set(cols[0]!, cols[1]!);
  }
  statusCache = { at: Date.now(), map };
  return map;
}

/** Health-first start: a machine the platform reports Running (dozing,
 *  live, or a warm standby the wake row targeted) needs nothing — the old
 *  path would have run the zombie stop-deploy dance on a healthy machine. */
async function ensureInstance(instance: string): Promise<string> {
  if (BACKEND === "tinfoil") {
    try {
      const st = (await instanceStatuses()).get(instance);
      if (st === "Running") return `already running: ${instance}`;
    } catch {
      /* status unknown — fall through to the deploy path */
    }
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
    // Open the release window at FIRE time, before the deploy: the boot's
    // pull lands seconds after the app starts (~90s), which can BEAT the
    // deploy CLI's own resolve — marking after it inverted the race and
    // the intended machine pulled `no-fire` (live-caught 01:23Z). The
    // standby-steal vector this ordering once guarded against is closed
    // by the pool's canFill deferral instead: no replacement boots while
    // a window is open. A failed deploy re-arms its row (the table spent
    // it, and the agent is asleep); the stale window just expires in 3min.
    handoff.markWakeFired(instance);
    const retryKey = `${instance}:${jobId}`;
    void ensureInstance(instance)
      .then((detail) => {
        wakeRetries.delete(retryKey); // budget is per failure-chain, not per schedule lifetime
        app.log.info({ instance, jobId, detail }, "wake row fired — deploy ok");
      })
      .catch((e) => {
        const n = (wakeRetries.get(retryKey) ?? 0) + 1;
        if (n < 3) {
          wakeRetries.set(retryKey, n);
          table.setWake(instance, jobId, 2 * 60_000);
          app.log.warn({ instance, jobId, attempt: n, err: String(e) }, "wake deploy failed — row re-armed (+2min)");
        } else {
          wakeRetries.delete(retryKey); // abandoned: a future occurrence starts fresh
          app.log.error({ instance, jobId, err: String(e) }, "wake deploy failed 3x — job abandoned (this occurrence)");
        }
      });
  },
);;

/** Wake-autonomy escrow: the user's boot credential in memory between
 * sessions. Released only to machines this concierge booted for a fired
 * wake row — standbys and user-wakes boot locked, by design. */
const handoff = createHandoffStore({ ttlMs: envInt("WAKE_HANDOFF_TTL_MS", 7 * 24 * 3600_000, 60_000) });

/** Bounded retry bookkeeping for failed schedule deploys (memory-only). */
const wakeRetries = new Map<string, number>();

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
  // Constant-time: a straight === leaks length/prefix timing on the
  // shared secret (SME review).
  if (!SHARED_SECRET) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(SHARED_SECRET);
  return a.length === b.length && timingSafeEqual(a, b);
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
        // SESSION-TIER ONLY (SME review): the external tier (shared secret /
  // any bb JWT) must never write table rows. A wake row written with the
  // shared secret mints a handoff release window on demand — the
  // fire-gate would be decorative. Machines always handshake before
  // writing rows (the sleep gate refuses to die without a session), so
  // nothing legitimate is lost.
  //
  // KNOWN SEAM (review, k=1 accepted): /handshake itself still verifies
  // at the external tier, so a shared-secret or bb-JWT holder can mint
  // a session and then write rows. Closing it needs per-machine
  // identity over the attested channel (PLAN.md); at k=1 the machines
  // already hold the escrow secret, so the added exposure is the
  // bb-JWT holder class only — /handshake below rejects bare JWTs to
  // shrink exactly that class to secret-holders.
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
/** A claim is bounded presence, not ownership: REPLACE the machine's
 *  boot-time stop row with a grace row (keyed by the machine's REAL name —
 *  concierge-side, the only correct-identity rows a standby has: machines
 *  self-report the config's shared identity and cannot know their own).
 *  If the user unlocks, the machine's own renewals keep it alive; if they
 *  abandon the claim, the machine dies within grace. Long by default: a
 *  claimed machine's own idle-sleep flare mis-targets the shared identity
 *  (open design item), so grace — not a flare — is what finally bounds an
 *  abandoned claim. */
  table.setStop(got.name, envInt("STANDBY_CLAIM_GRACE_MS", 12 * 3600_000, 60_000));
  void pool.tick().catch(() => undefined); // top the pool back up promptly
  return got;
});

/** Handshake: betterbase JWT (or dev secret) → session token. Once per
 *  agent boot; re-running returns the SAME token (shared identity —
 *  the machine cannot tell a reboot from a re-handshake). */
app.post<{ Body: { instance?: string } }>("/handshake", async (req, reply) => {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const { instance } = req.body ?? {};
  if (!allowedInstance(instance)) return reply.code(403).send({ error: "instance not allowed" });
  // SECRET-ONLY (review): the general external tier also accepts bb
  // JWTs, but a handshake mints a session and sessions write table rows
  // — letting any JWT holder reach /timer re-opens the decorative
  // fire-gate the session-tier rule closed. Machines always hold the
  // shared secret (their handshake bearer); nothing legitimate loses
  // access. Constant-time, as everywhere the secret is compared.
  const a = Buffer.from(token ?? "");
  const b = Buffer.from(SHARED_SECRET ?? "");
  const secretOk = !!SHARED_SECRET && a.length === b.length && timingSafeEqual(a, b);
  if (!secretOk) return reply.code(401).send({ error: "unauthorized" });
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

/** Operator/debug: the table, no secrets — but AUTHENTICATED (SME
 * review): the snapshot names standby machines (names authorize the
 * standby namespace), exposes schedule timing, and reveals when the
 * escrow is armed. /health stays open with counts only. */
app.get("/status", async (req, reply) => {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!(await verifyExternal(token))) return reply.code(401).send({ error: "unauthorized" });
  return {
    now: Date.now(),
    instances: table.snapshot().map((e) => ({ ...e, wake_handoff: handoff.status(e.instance) })),
  };
});

/** Arm the wake handoff: the unlocking machine parks its boot credential
 * here (memory-only) so a later schedule-boot can run unattended. Auth is
 * the same external tier as /handshake — the fresh bb JWT or the shared
 * secret — because this fires seconds after a successful unlock.
 * `clear: true` is the disarm verb (user rotation / "stop while I'm
 * away"): wipes the row and any open release window. */
app.post<{
  Body: { instance?: string; secret?: string; inferenceKey?: string; ttl_ms?: number; clear?: boolean };
}>("/handoff", async (req, reply) => {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const { instance, secret, inferenceKey, ttl_ms, clear } = req.body ?? {};
  if (!allowedInstance(instance)) return reply.code(403).send({ error: "instance not allowed" });
  if (!(await verifyExternal(token))) return reply.code(401).send({ error: "unauthorized" });
  reply.header("cache-control", "no-store");
  if (clear) {
    handoff.clear(instance);
    app.log.info({ instance }, "wake handoff disarmed");
    return { ok: true, cleared: true };
  }
  if (typeof secret !== "string" || !secret) return reply.code(400).send({ error: "secret required" });
  const res = handoff.arm(instance, { secret, inferenceKey }, ttl_ms);
  app.log.info({ instance, expires_in_ms: res.expires_in_ms }, "wake handoff armed (memory-only)");
  return { ok: true, ...res };
});

/** Pull the wake handoff: a just-booted locked machine asks for its
 * credential. POST (never GET — no caching, no URL-borne secrets) and
 * the fire-gate is the whole security story: a boot that the concierge
 * did not successfully deploy for a schedule gets 404 and stays a
 * normal locked ceremony. */
app.post<{ Body: { instance?: string } }>("/handoff/pull", async (req, reply) => {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const instance = req.body?.instance;
  if (!allowedInstance(instance)) return reply.code(403).send({ error: "instance not allowed" });
  if (!(await verifyExternal(token))) return reply.code(401).send({ error: "unauthorized" });
  reply.header("cache-control", "no-store");
  const res = handoff.release(instance);
  if ("notFound" in res) {
    app.log.info({ instance, reason: res.reason }, "wake handoff pull denied");
    return reply.code(404).send({ error: `no handoff (${res.reason})` });
  }
  app.log.info({ instance, armed_ms_ago: res.armed_ms_ago }, "wake handoff released to schedule-boot");
  return { secret: res.secret, inferenceKey: res.inferenceKey };
});

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
          // create must not wedge nextName on the same index forever.
          // NO --variable flags: env changes the MEASUREMENT (proven live
          // — the client correctly refused a standby whose per-instance
          // variables broke the signed-release match). Pool machines run
          // the exact committed config; per-machine identity is an open
          // design item (see evidence).
          const args = [
            "container", "create", name,
            "--repo", STANDBY_CONFIG_REPO,
            "--tag", STANDBY_CONFIG_TAG,
            "--no-wait",
          ];
          for (const s of STANDBY_SECRETS) args.push("--secret", s);
          await exec("tinfoil", args, { timeout: 30_000 });
        },
        destroy: async (name) => {
          try {
            await restInstance(name);
            await exec("tinfoil", ["container", "delete", name], { timeout: 60_000 });
          } finally {
            // The name frees on EVERY outcome — success or not-found both
            // mean the machine is gone, and a failed destroy retries with
            // the name still held; leaving it burned on the throw path
            // drifted the recycled namespace (review finding).
            poolNames.delete(name);
          }
        },
        health: async (name) => (await instanceStatuses().catch(() => new Map())).get(name) === "Running",
        urlFor: (name) => `https://${name}.${DOMAIN_BASE}`,
        nextName: () => {
          for (let i = 1; ; i++) {
            const n = `${STANDBY_PREFIX}${i}`;
            if (!poolNames.has(n)) return n;
          }
        },
        now: () => Date.now(),
        log: (msg, fields) => app.log.info(fields ?? {}, msg),
        // Never boot a replacement while a handoff release window is
        // open for ANY allowed instance: a replacement boot racing the
        // intended pull is the standby-steal path (SME review).
        canFill: () => ![...ALLOWED].some((i) => handoff.windowOpen(i)),
      },
    )
  : null;
if (pool) {
  /** Leftover scan after a reboot (our memory is wiped). Stopped
   *  standbys are provably session-less (state lives on the shelf; the
   *  claimant's client simply gets assigned another machine) — adopted
   *  as booting. Running ones have unknown claim status — adopted as
   *  FOREIGN: never assignable, reaped on the claim-grace clock (a
   *  user may be mid-session on one; only their own gates, grace rows,
   *  and the hard sweep own them). Runs at boot and periodically — a
   *  failed scan retries instead of waiting for the next process
   *  restart. */
  const scanLeftovers = () =>
    instanceStatuses()
      .then(async (statuses) => {
        const stopped: string[] = [];
        const running: string[] = [];
        for (const [n, st] of statuses) {
          if (!STANDBY_NAME_RE.test(n) || poolNames.has(n)) continue;
          poolNames.add(n);
          // Stopped leftovers are provably session-less (state lives on
          // the shelf) — adopt as booting, they re-enter the normal
          // TTL/health lifecycle. Running leftovers have UNKNOWN claim
          // status: a user may be mid-session on one. They are adopted
          // as foreign — never assignable, reaped on the claim-grace
          // clock, not the pool TTL (review finding: adopt-as-booting
          // let the pool re-hand-out and then TTL-delete a claimed
          // machine).
          if (st === "Stopped") stopped.push(n);
          else if (st === "Running") running.push(n);
          else app.log.info({ name: n, status: st }, "pool: leftover not adoptable yet");
        }
        if (stopped.length > 0) pool.adopt(stopped);
        if (running.length > 0) pool.adoptForeign(running);
        app.log.info({ adopted_stopped: stopped.length, adopted_running_foreign: running.length }, "pool: platform standby scan");
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
