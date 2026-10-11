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
import type { FastifyReply } from "fastify";
import cors from "@fastify/cors";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createVerifyExternal, secretOk } from "./auth.js";
import type {
  HandshakeRequest,
  HandoffArmRequest,
  HandoffPullRequest,
  PostboxPostRequest,
  PostboxPullRequest,
  TimerRequest,
  WakeRequest,
  BootRequest,
} from "@waddle/sdk";
import pkg from "../package.json" with { type: "json" };
import { createTable } from "./table.js";
import { createHandoffStore } from "./handoff.js";
import { createPostboxStore } from "./postbox.js";
import { createPool, envInt, standbyNameRe, type Pool } from "./pool.js";
import { createPlatform } from "./platform.js";
import { createUserMachines, userNameRe, hashSub } from "./user-machines.js";

const exec = promisify(execFile);

const PORT = Number(process.env.CONCIERGE_PORT ?? 8081);
const JWKS_URL = process.env.CONCIERGE_JWKS_URL ?? "";
const ISSUER = process.env.CONCIERGE_ISSUER ?? "";
const AUDIENCE = process.env.CONCIERGE_AUDIENCE ?? "";
/** docker | tinfoil — config-selected backend (seam, not code fork). */
const BACKEND = process.env.CONCIERGE_BACKEND ?? "docker";
/** Hard backstop: stop managed instances silent longer than this. */
const HARD_STOP_MS = envInt("CONCIERGE_HARD_STOP_MS", 24 * 3600_000, 60_000);
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

const verifyExternal = createVerifyExternal({
  jwksUrl: JWKS_URL,
  issuer: ISSUER,
  audience: AUDIENCE,
  sharedSecret: SHARED_SECRET,
});
// (an empty audience with JWKS configured now throws at boot, in auth.ts)

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
/** How long a claimed-but-abandoned standby may live (the /assign grace
 *  row AND the pool's foreign-reap clock share this one knob). */
const CLAIM_GRACE_MS = envInt("STANDBY_CLAIM_GRACE_MS", 12 * 3600_000, 60_000);

// ── User machines (the cattle spine — module semantics in
// user-machines.ts). Names authorize the namespace exactly like
// standby names: strict shape AND created/adopted here. The sub→name
// map is memory-only; after a concierge reboot the hash embedded in
// every name rebinds it from the platform list.
const users = createUserMachines();
const USER_NAME_RE = userNameRe();

// ── Platform verbs (the only shell-outs live in platform.ts) ────────────

/** The tag every deploy boots — the pool's tag by default, so /wake and
 *  standby creates can never skew from what the client verifies (latest
 *  release of the config repo). */
const DEPLOY_TAG = process.env.CONCIERGE_DEPLOY_TAG ?? (POOL_CAPABLE ? STANDBY_CONFIG_TAG : "");
const platform = createPlatform({
  backend: BACKEND as "docker" | "tinfoil",
  deployTag: DEPLOY_TAG,
  domainBase: DOMAIN_BASE,
});

// ── The table (semantics live in table.ts; platform verbs fire here) ─────

const app = fastify({ logger: true });

const table = createTable(
  (instance) => {
    void platform.rest(instance)
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
    // 90s probe budget: a healthy machine answers within one boot (~90s)
    // of probe start; a booting replacement that pulls in-window becomes
    // the scheduled boot on its own. In prod the probe egress is blocked
    // by the platform firewall (instance hosts can't be allowlisted —
    // NXDOMAIN while stopped), so fires degrade to always-dance: probe
    // 90s + dance ~4min + boot ~90s ≈ 7min, inside the 10-min window.
    void platform.ensure(instance, 90_000, "fire")
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
  });

/** Wake-autonomy escrow: the user's boot credential in memory between
 *  sessions. Released only to machines this concierge booted for a fired
 *  wake row — standbys and user-wakes boot locked, by design. */
// releaseWindowMs: the fire→pull gap is normally ~90s (the boot pulls as
// soon as the app starts), but platform-side stages can stall — a measured
// certificate issuance of 5.4 min (2026-10-10 v0.0.46 ceremony) made the
// old hard 3-min window close before the pull. Configurable; the SME race
// concern stands for *very* long windows, so the default stays tight.
const handoff = createHandoffStore({
  ttlMs: envInt("WAKE_HANDOFF_TTL_MS", 7 * 24 * 3600_000, 60_000),
  releaseWindowMs: envInt("WAKE_RELEASE_WINDOW_MS", 3 * 60_000, 30_000),
});

/** Return mail for unattended runs — sealed blobs only, pull-and-clear. */
const postbox = createPostboxStore({ ttlMs: envInt("WAKE_POSTBOX_TTL_MS", 7 * 24 * 3600_000, 60_000) });

/** Bounded retry bookkeeping for failed schedule deploys (memory-only). */
const wakeRetries = new Map<string, number>();

// ── Auth ─────────────────────────────────────────────────────────────────
// Four tiers, one grep away:
//   requireExternal  bb JWT or shared secret  (/wake /assign /status)
//   requireJwtUser   bb JWT, returns its sub  (/boot — machines have no
//                    user identity; the shared secret is NOT enough)
//   requireSession   handshake-minted token   (/timer /handoff/post /handoff/post/pull)
//   requireSecret    shared secret only       (/handshake bearer, /handoff, /handoff/pull)
// The escrow routes are MACHINE verbs (arm at sleep, pull at boot — both
// present the env shared secret) and they move the master secret: the
// external tier — every waddle-app JWT holder — must never reach them
// (review-caught: arm had no gate at all, pull only the fire window).

/** Bearer token from a request header. */
function bearer(req: { headers: { authorization?: string } }): string | undefined {
  return req.headers.authorization?.replace(/^Bearer\s+/i, "");
}

/** Verify a betterbase JWT or the shared secret — the external tier,
 *  factored into auth.ts (tested there). */

function allowedInstance(instance: string | undefined): instance is string {
  if (typeof instance !== "string") return false;
  if (ALLOWED.has(instance)) return true;
  // Standby namespace: strict shape AND a name this process created or
  // adopted — a bare prefix match would let any token holder mint rows
  // against operator-invisible instances (and grow the table unbounded).
  // User machines follow the same rule via the registry's known-set.
  if (POOL_ENABLED && STANDBY_NAME_RE.test(instance) && poolNames.has(instance)) return true;
  return USER_NAME_RE.test(instance) && users.known().has(instance);
}

/** Session tokens: handshake-minted, instance-scoped, memory-only.
 *
 * SESSION-TIER ONLY (SME review): the external tier (shared secret / any
 * bb JWT) must never write table rows. A wake row written with the shared
 * secret mints a handoff release window on demand — the fire-gate would
 * be decorative. Machines always handshake before writing rows (the sleep
 * gate refuses to die without a session), so nothing legitimate is lost.
 *
 * KNOWN SEAM (review, k=1 accepted): /handshake itself still verifies at
 * the external tier, so a shared-secret or bb-JWT holder can mint a
 * session and then write rows. Closing it needs per-machine identity over
 * the attested channel (PLAN.md); at k=1 the machines already hold the
 * escrow secret, so the added exposure is the bb-JWT holder class only —
 * /handshake below rejects bare JWTs to shrink exactly that class to
 * secret-holders. */
async function authorize(req: { headers: { authorization?: string }; body?: { instance?: string } }): Promise<string | null> {
  const token = bearer(req);
  const instance = req.body?.instance;
  if (!token || !allowedInstance(instance)) return null;
  const e = table.entry(instance);
  if (e && token === e.sessionToken) {
    e.lastContact = Date.now();
    return instance;
  }
  return null;
}

/** External tier (bb JWT or shared secret). Replies 401 and returns false
 *  when the bearer does not pass. */
async function requireExternal(req: { headers: { authorization?: string } }, reply: FastifyReply): Promise<boolean> {
  if (await verifyExternal(bearer(req))) return true;
  reply.code(401).send({ error: "unauthorized" });
  return false;
}

/** The user tier: a verified bb JWT, returning its `sub`. The shared
 *  secret is a MACHINE identity — it names no user, so /boot refuses it
 *  (403, not 401: the bearer verified, it just isn't a user). */
async function requireJwtUser(req: { headers: { authorization?: string } }, reply: FastifyReply): Promise<string | null> {
  const id = await verifyExternal(bearer(req));
  if (id?.kind === "jwt") return id.sub;
  reply.code(id ? 403 : 401).send({ error: id ? "user identity required — connect your store" : "unauthorized" });
  return null;
}

/** Session tier (handshake-minted token). Replies 401 and returns null
 *  when the bearer is not a live session for an allowed instance. */
async function requireSession(
  req: { headers: { authorization?: string }; body?: { instance?: string } },
  reply: FastifyReply,
): Promise<string | null> {
  const instance = await authorize(req);
  if (instance === null) {
    reply.code(401).send({ error: "unauthorized" });
    return null;
  }
  return instance;
}

/** The machine tier: the shared secret only — escrow verbs and session
 *  minting move the master secret and must stay out of external reach. */
function requireSecret(req: { headers: { authorization?: string } }, reply: FastifyReply): boolean {
  if (!secretOk(bearer(req), SHARED_SECRET)) {
    reply.code(401).send({ error: "unauthorized" });
    return false;
  }
  return true;
}

/** No-store on every route that can return secrets or sealed mail. */
function noStore(reply: FastifyReply): void {
  reply.header("cache-control", "no-store");
}

// ── Service ──────────────────────────────────────────────────────────────

await app.register(cors, {
  origin: (process.env.CONCIERGE_ALLOWED_ORIGINS ?? "http://localhost:5173").split(","),
});

app.get("/health", async () => ({
  service: "waddle-concierge",
  version: pkg.version,
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
  if (!(await requireExternal(req, reply))) return reply;
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
  table.setStop(got.name, CLAIM_GRACE_MS);
  void pool.tick().catch(() => undefined); // top the pool back up promptly
  return got;
});

/** Create an instance from the committed config (pool standbys AND
 *  user machines — one create path, one measurement). NO --variable
 *  flags: env changes the MEASUREMENT (proven live — the client
 *  correctly refused a standby whose per-instance variables broke the
 *  signed-release match). Machines run the exact committed config. */
async function createInstance(name: string): Promise<void> {
  const args = [
    "container", "create", name,
    "--repo", STANDBY_CONFIG_REPO,
    "--tag", STANDBY_CONFIG_TAG,
    "--no-wait",
  ];
  for (const s of STANDBY_SECRETS) args.push("--secret", s);
  await exec("tinfoil", args, { timeout: 30_000 });
}

/** The user's discovery verb: "my machine, running". Idempotent, and
 *  the ONLY public path that mints user machines — first /boot tries a
 *  warm standby (seconds to live), then boots fresh (~90s). Later boots
 *  return the existing machine, ensured (user mode: a healthy Running
 *  machine is never stopped; a stopped one deploys). */
app.post<{ Body: BootRequest }>("/boot", async (req, reply) => {
  const sub = await requireJwtUser(req, reply);
  if (sub === null) return reply;
  // Observed-death wake: the client watched the old machine stop — its
  // name is dead weight in browser caches for up to the negative TTL;
  // a fresh mint sidesteps the poison entirely (blank machines are
  // cattle; the shelf holds all state).
  const wantFresh = req.body?.fresh === true;
  if (wantFresh) {
    const old = users.rebind(sub);
    if (old) {
      users.retire(old); // tombstoned — the platform scan must not resurrect it
      void platform.rest(old).catch(() => undefined); // blank machine; nothing to keep
      app.log.info({ user: hashSub(sub), instance: old }, "boot: fresh requested — old name retired");
    }
  }
  // Warm-first: a pool standby is already booted and measured — claiming
  // one saves the ~90s deploy. Same claim-grace contract as /assign: a
  // claimed machine the user abandons dies within grace, not the pool TTL.
  let name = users.rebind(sub);
  if (!name && POOL_ENABLED && pool) {
    const got = pool.assign();
    if (got) {
      // Claim-time tag gate: a warm standby on any tag but the current
      // release would sail through assignment and die at the client's
      // measurement pin (live-proven refusal class). Refuse here, stop
      // the stale stock, fall through to a fresh mint.
      const tag = (await platform.statusRows().catch(() => new Map())).get(got.name)?.tag;
      if (tag && tag !== (STANDBY_CONFIG_TAG || tag)) {
        app.log.warn({ instance: got.name, tag, expected: STANDBY_CONFIG_TAG }, "boot: refusing stale-tag standby — destroying");
        await platform.rest(got.name).catch(() => undefined);
        users.forget(got.name);
      } else {
        users.claim(sub, got.name);
        table.setStop(got.name, CLAIM_GRACE_MS);
        void pool.tick().catch(() => undefined);
        name = got.name;
        app.log.info({ user: hashSub(sub), instance: name }, "boot: claimed warm standby");
      }
    }
  }
  let fresh = false;
  if (!name) {
    name = users.bind(sub);
    fresh = true;
  }
  if (fresh && POOL_CAPABLE) {
    try {
      // --no-wait: the create IS the deploy — following it with
      // platform.ensure() would race the in-flight create ("cannot
      // deploy a started instance", the exact 409 seen live 01:23Z) and
      // 502 the client. Fresh machines return waking immediately.
      await createInstance(name);
    } catch (e) {
      users.forget(name);
      app.log.warn({ err: String(e) }, "boot: create failed");
      return reply.code(502).send({ error: e instanceof Error ? e.message : String(e) });
    }
    table.userWake(name);
    // Wait for Running via the platform API before handing out the URL:
    // the DNS record lands ~when the machine goes Running, and the
    // client's first /health poll must not query a record that doesn't
    // exist yet — that NXDOMAIN caches for the SOA negative TTL and the
    // machine is browser-unreachable for 30min from its own boot polls
    // (caught live 01:5xZ). Timeout still responds waking (honest — the
    // machine boots; a rare cert stall just means a slower client poll).
    const running = await platform.waitRunning(name, 180_000);
    const dns = running ? await platform.awaitDns(`${name}.${DOMAIN_BASE}`, 25_000) : false;
    app.log.info({ user: hashSub(sub), instance: name, running, dns }, "boot: fresh machine created");
    return reply.code(202).send({
      instance: name,
      url: `https://${name}.${DOMAIN_BASE}`,
      status: "waking",
      detail: running ? "created (running)" : "created (still provisioning)",
    });
  }
  // A user present means the machine should live: clear any pending
  // stop FIRST, then the claim-grace row lands last and sticks (an
  // abandoned warm claim dies on the grace clock; the machine's own
  // timer writes replace the row once the user actually unlocks).
  table.userWake(name);
  if (POOL_ENABLED && pool && STANDBY_NAME_RE.test(name)) table.setStop(name, CLAIM_GRACE_MS);
  try {
    const detail = await platform.ensure(name);
    const dns = await platform.awaitDns(`${name}.${DOMAIN_BASE}`, 120_000).catch(() => false);
    const running = detail.startsWith("already running");
    app.log.info({ user: hashSub(sub), instance: name, detail, dns }, "boot");
    return reply.code(running ? 200 : 202).send({
      instance: name,
      url: `https://${name}.${DOMAIN_BASE}`,
      status: running ? "running" : "waking",
      detail,
    });
  } catch (e) {
    return reply.code(502).send({ error: e instanceof Error ? e.message : String(e) });
  }
});

/** The readiness poll (see sdk BootReadyResponse): the client asks the
 *  CONCIERGE — never the booting machine — until the machine is really
 *  reachable: Running + DNS live (c-ares, cache-free) + /health answers.
 *  Only then does the browser learn the machine's name, so its first
 *  query is a positive answer and no cache in its chain ever sees the
 *  name dead. */
app.get<{ Querystring: { instance?: string } }>("/boot/ready", async (req, reply) => {
  if (!(await requireExternal(req, reply))) return reply;
  const { instance } = req.query ?? {};
  if (!instance || !allowedInstance(instance)) return reply.code(403).send({ error: "instance not allowed" });
  // docker has no status feed (statuses() is empty) — discovery there is
  // dev-parity only; treat the machine as running once asked.
  if (BACKEND === "tinfoil") {
    const st = (await platform.statuses().catch(() => new Map())).get(instance);
    if (st !== "Running") return reply.code(503).send({ instance, ready: false, why: "status" });
  }
  // NO /health probe leg: the concierge's egress cannot reach instance
  // hosts (firewall model — hostname allowlists can't express them). The
  // client probes /health itself once ready — by then the record is live,
  // so a slow agent is a connection refusal, never a cacheable NXDOMAIN.
  const dns = await platform.awaitDns(`${instance}.${DOMAIN_BASE}`, 6_000).catch(() => false);
  if (!dns) return reply.code(503).send({ instance, ready: false, why: "dns" });
  return { instance, ready: true };
});

/** Handshake: betterbase JWT (or dev secret) → session token. Once per
 *  agent boot; re-running returns the SAME token (shared identity —
 *  the machine cannot tell a reboot from a re-handshake). */
app.post<{ Body: HandshakeRequest }>("/handshake", async (req, reply) => {
  // CATTLE IDENTITY: the session's table key is resolved HERE, never
  // trusted from the body. Two tiers:
  //  - bb JWT (the unlock handshake): the caller's registry row names the
  //    machine. A JWT holder gets rows for THEIR machine only — strictly
  //    narrower than the shared-secret tier, so accepting JWTs here does
  //    not re-open the fire-gate the session rule closed.
  //  - shared secret (autonomous boot, dev): the body name is validated
  //    against the known set; an autonomous boot passes the name its
  //    /handoff/pull taught it (the concierge's own record).
  const id = await verifyExternal(bearer(req));
  if (id?.kind === "jwt") {
    const resolved = users.rebind(id.sub);
    if (!resolved) return reply.code(404).send({ error: "no machine for user — POST /boot first" });
    const sessionToken = table.mintSession(resolved);
    return { session_token: sessionToken, instance: resolved };
  }
  const { instance } = req.body ?? {};
  if (!allowedInstance(instance)) return reply.code(403).send({ error: "instance not allowed" });
  // SECRET-ONLY fallback (review): machines always hold the shared
  // secret (their handshake bearer); nothing legitimate loses access.
  // Constant-time, as everywhere the secret is compared.
  if (!requireSecret(req, reply)) return reply;
  const sessionToken = table.mintSession(instance);
  return { session_token: sessionToken, instance };
});

/** The table write. Replace semantics ARE the policy:
 *  stop rows are singleton-per-instance (debounce), wake rows are
 *  job-keyed one-shots. due_ms is relative (skew-immune); 0 cancels. */
app.post<{ Body: TimerRequest }>("/timer", async (req, reply) => {
  const instance = await requireSession(req, reply);
  if (instance === null) return reply;
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
app.post<{ Body: WakeRequest }>("/wake", async (req, reply) => {
  const { instance } = req.body ?? {};
  if (!allowedInstance(instance)) return reply.code(403).send({ error: "instance not allowed" });
  if (!(await requireExternal(req, reply))) return reply;
  // A user present means the machine should live: clear any pending stop.
  table.userWake(instance);
  try {
    const detail = await platform.ensure(instance);
    return reply.code(202).send({ status: "waking", detail });
  } catch (err) {
    return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** Operator/debug: the table, no secrets — but AUTHENTICATED (SME
 *  review): the snapshot names standby machines (names authorize the
 *  standby namespace), exposes schedule timing, and reveals when the
 *  escrow is armed. /health stays open with counts only. */
app.get("/status", async (req, reply) => {
  if (!(await requireExternal(req, reply))) return reply;
  return {
    now: Date.now(),
    instances: table.snapshot().map((e) => ({ ...e, wake_handoff: handoff.status(e.instance), postbox: postbox.status(e.instance) })),
  };
});

/** Arm the wake handoff: the unlocking machine parks its boot credential
 *  here (memory-only) so a later schedule-boot can run unattended. Auth is
 *  the same external tier as /handshake — the fresh bb JWT or the shared
 *  secret — because this fires seconds after a successful unlock.
 *  `credential` is an OPAQUE bag the concierge never interprets (today:
 *  { secret, schedules[], snapshot? } — the master secret plus due work
 *  and a sealed snapshot; two-tier autonomy, PLAN.md — the warned
 *  background-tasks opt-in IS the delegation boundary, and the bag rides
 *  concierge memory only, never disk). `clear: true` is the disarm verb
 *  (user rotation / "stop while I'm away"): wipes the row and any open
 *  release window. */
app.post<{ Body: HandoffArmRequest }>("/handoff", async (req, reply) => {
  const { instance, credential, ttl_ms, clear } = req.body ?? {};
  if (!allowedInstance(instance)) return reply.code(403).send({ error: "instance not allowed" });
  if (!requireSecret(req, reply)) return reply;
  noStore(reply);
  if (clear) {
    handoff.clear(instance);
    app.log.info({ instance }, "wake handoff disarmed");
    return { ok: true, cleared: true };
  }
  if (!credential || typeof credential !== "object" || Object.keys(credential).length === 0) {
    return reply.code(400).send({ error: "credential payload required (non-empty)" });
  }
  const res = handoff.arm(instance, credential, ttl_ms);
  app.log.info({ instance, expires_in_ms: res.expires_in_ms, keys: Object.keys(credential) }, "wake handoff armed (memory-only)");
  return { ok: true, ...res };
});

/** Pull the wake handoff: a just-booted locked machine asks for its
 *  credential. POST (never GET — no caching, no URL-borne secrets) and
 *  the fire-gate is the whole security story: a boot that the concierge
 *  did not successfully deploy for a schedule gets 404 and stays a
 *  normal locked ceremony. */
app.post<{ Body: HandoffPullRequest }>("/handoff/pull", async (req, reply) => {
  const { instance } = req.body ?? {};
  if (!allowedInstance(instance)) return reply.code(403).send({ error: "instance not allowed" });
  if (!requireSecret(req, reply)) return reply;
  noStore(reply);
  const res = handoff.release(instance);
  if ("notFound" in res) {
    // CATTLE FALLBACK (k=1): a wake boot can't know its own name — it
    // pulls under the legacy shared key. Only such a caller (a name in
    // NO dynamic namespace) gets the fallback, and only when exactly
    // one fire window is open anywhere — that fire's boot is this
    // puller. Exposure is exactly today's (the legacy key was the
    // fleet-wide key); a caller that DOES know a real name gets
    // exact-key semantics only. k>1 ambiguity denies (platform ask).
    const legacyCaller = !USER_NAME_RE.test(instance) && !STANDBY_NAME_RE.test(instance);
    const open = legacyCaller ? handoff.singleOpenWindow() : null;
    if (open) {
      const via = handoff.release(open);
      if (!("notFound" in via)) {
        app.log.info({ asked: instance, serving: open }, "wake handoff pull resolved via open fire window");
        return { credential: via.cred, instance: open };
      }
    }
    app.log.info({ instance, reason: res.reason }, "wake handoff pull denied");
    return reply.code(404).send({ error: `no handoff (${res.reason})` });
  }
  app.log.info({ instance, armed_ms_ago: res.armed_ms_ago, keys: Object.keys(res.cred) }, "wake handoff released to schedule-boot");
  return { credential: res.cred, instance };
});

/** Post a sealed blob — an autonomous machine's return mail at re-sleep.
 *  The blob is AEAD ciphertext (instance-bound AAD, sealed under a key
 *  derived from the master secret): the concierge holds mail it cannot
 *  open. External-tier auth is fine — a forged row is undecryptable
 *  junk, not a credential. */
// bodyLimit 8MiB on THIS route only (default elsewhere — a raise is an
// unauthenticated buffering surface; the postbox carries one run's sealed
// tail, client-capped at 200 events).
app.post<{ Body: PostboxPostRequest }>(
  "/handoff/post",
  { bodyLimit: 8 * 1024 * 1024 },
  async (req, reply) => {
    // SESSION tier (like /timer): both writers — the autonomous machine at
    // re-sleep and the unlocking machine at collection — handshook first.
    // A bearer confusion here (session token sent to an external-tier
    // endpoint) once 401'd AND killed the sender's session (review finding).
    const instance = await requireSession(req, reply);
    if (instance === null) return reply;
    const { blob, clear } = req.body ?? {};
    noStore(reply);
    if (clear) {
      postbox.clear(instance);
      return { ok: true, cleared: true };
    }
    if (typeof blob !== "string" || !blob) return reply.code(400).send({ error: "blob required" });
    const res = postbox.post(instance, blob);
    app.log.info({ instance, bytes: blob.length, expires_in_ms: res.expires_in_ms }, "postbox stored (sealed)");
    return { ok: true, ...res };
  },
);

/** Pull the postbox: the machine at the next unlock (which can derive the
 *  seal key) collects and clears the mail. One delivery. */
app.post<{ Body: PostboxPullRequest }>("/handoff/post/pull", async (req, reply) => {
  const instance = await requireSession(req, reply); // session tier — see /handoff/post
  if (instance === null) return reply;
  noStore(reply);
  const blob = postbox.pull(instance);
  if (blob === null) return reply.code(404).send({ error: "no mail" });
  app.log.info({ instance, bytes: blob.length }, "postbox delivered (pull-and-clear)");
  return { blob };
});

// ── The pool (module semantics in pool.ts; platform verbs here) ───────

/** Names the pool must never collide with: seeded from the platform
 *  (our memory is wiped on reboot — leftover standbys exist) and grown as
 *  we create. Also the authority for the standby namespace —
 *  allowedInstance accepts only names it contains. */
const poolNames = new Set<string>();
const pool: Pool | null = POOL_CAPABLE
  ? createPool(
      { size: POOL_ENABLED ? POOL_SIZE : 0, ttlMs: STANDBY_TTL_MS, claimGraceMs: CLAIM_GRACE_MS, expectedTag: STANDBY_CONFIG_TAG || undefined },
      {
        boot: async (name) => {
          poolNames.add(name); // burn the name even on failure — a colliding
          // create must not wedge nextName on the same index forever.
          await createInstance(name);
        },
        destroy: async (name) => {
          try {
            await platform.rest(name);
            await exec("tinfoil", ["container", "delete", name], { timeout: 60_000 });
          } finally {
            // The name frees on EVERY outcome — success or not-found both
            // mean the machine is gone, and a failed destroy retries with
            // the name still held; leaving it burned on the throw path
            // drifted the recycled namespace (review finding).
            poolNames.delete(name);
          }
        },
        health: async (name) => (await platform.statuses().catch(() => new Map())).get(name) === "Running",
        urlFor: (name) => `https://${name}.${DOMAIN_BASE}`,
        tagOf: async (name) =>
          (await platform.statusRows().catch(() => new Map())).get(name)?.tag,
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
        // Keys are runtime-minted names (post-adoption) — a static set
        // can't enumerate them. Any open window defers fills.
        canFill: () => !handoff.anyWindowOpen(),
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
    platform.statuses()
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

// ── User-machine scan: the registry's known-set refills from the
// platform (the durable truth) on boot and periodically — independent
// of the pool, which may be disabled while /boot still serves. The
// sub→name map rebinds lazily at /boot via the name's embedded hash.
if (BACKEND === "tinfoil") {
  const scanUsers = () =>
    platform.statuses()
      .then((statuses) => {
        const adopted = users.adopt([...statuses.keys()]);
        if (adopted > 0) app.log.info({ adopted }, "user machines adopted from platform");
      })
      .catch(() => undefined); // retried next interval
  void scanUsers();
  setInterval(() => void scanUsers(), envInt("POOL_SCAN_MS", 5 * 60_000, 10_000)).unref();
}

// ── Backstop sweep: managed instances gone quiet get stopped ─────────────
// Covers missed death-flares and our own post-reboot amnesia. Scoped to
// ALLOWED — never the whole docker host or platform account.
setInterval(
  () => {
    void (async () => {
      const names = await platform.list().catch((e) => {
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
        await platform.rest(name).catch(() => undefined);
      }
    })();
  },
  envInt("CONCIERGE_SWEEP_MS", 15 * 60_000, 10_000),
).unref();

await app.listen({ port: PORT, host: "0.0.0.0" });
