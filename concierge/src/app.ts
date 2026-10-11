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
 *   user appears  → client POSTs /boot (discovery: ensure MY machine)
 *
 * Memory-only by design: a reboot wipes every row and every session token
 * (death is the strongest revocation). Clients/agents heal by
 * re-handshaking on their next boot. The backstop sweep DESTROYS
 * abandoned instances that went silent for HARD_STOP_MS (the user/
 * standby namespaces carry the machines; CONCIERGE_ALLOWED_INSTANCES
 * adds operator-named extras, default none) — that also covers our own
 * amnesia after a reboot.
 *
 * Compromise costs availability and money, never confidentiality: a fresh
 * boot sits at its lock screen. Egress belongs on the controlplane (plus
 * JWKS for auth) — the container config enforces it, this code assumes it.
 *
 * The service is built by buildApp() so tests can drive the real routes
 * with app.request() (injecting a fake Platform seam); index.ts is the
 * thin production entry.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
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
  BootRequest,
} from "@waddle/sdk";
import pkg from "../package.json" with { type: "json" };
import { createTable } from "./table.js";
import { createHandoffStore } from "./handoff.js";
import { createPostboxStore } from "./postbox.js";
import { createPool, envInt, standbyNameRe, type Pool } from "./pool.js";
import { createPlatform, type Platform } from "./platform.js";
import { createUserMachines, userNameRe, hashSub } from "./user-machines.js";

const exec = promisify(execFile);

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
 *  platform — other containers, other accounts' work — is invisible.
 *  Default: NO operator-named instances — the user namespace
 *  (waddle-u<hash>-<rand>, registry-gated) and the standby namespace
 *  (pool-gated) are the whole fleet. The old shared "waddle" primary
 *  died with the cattle design (identity is concierge-resolved). */
const ALLOWED = new Set(
  (process.env.CONCIERGE_ALLOWED_INSTANCES ?? "")
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
/** How long a claimed-but-abandoned machine may live (the /boot
 * claim-grace rows AND the pool's foreign-reap clock share this one
 * knob). */
const CLAIM_GRACE_MS = envInt("STANDBY_CLAIM_GRACE_MS", 12 * 3600_000, 60_000);

/** The tag every deploy boots — the pool's tag by default, so /boot
 * deploys and standby creates can never skew from what the client
 * verifies (latest release of the config repo). */
const DEPLOY_TAG = process.env.CONCIERGE_DEPLOY_TAG ?? (STANDBY_CONFIG_TAG || "");

const safeJson = (f: Record<string, unknown>): string => {
  try {
    return JSON.stringify(f);
  } catch {
    return "{}";
  }
};
/** Structured log → stdout (what fastify's logger did for us). */
const clog = {
  info: (msg: string, fields?: Record<string, unknown>) =>
    console.log(`${new Date().toISOString()} INFO ${msg}${fields ? ` ${safeJson(fields)}` : ""}`.trimEnd()),
  warn: (msg: string, fields?: Record<string, unknown>) =>
    console.log(`${new Date().toISOString()} WARN ${msg}${fields ? ` ${safeJson(fields)}` : ""}`.trimEnd()),
  error: (msg: string, fields?: Record<string, unknown>) =>
    console.log(`${new Date().toISOString()} ERROR ${msg}${fields ? ` ${safeJson(fields)}` : ""}`.trimEnd()),
};

/** JSON body reader with a byte cap — carries over fastify's default
 *  1MiB bodyLimit (an unbounded parse is an unauthenticated buffering
 *  surface; /handoff/post is the one deliberate 8MiB raise). 413 over
 *  the cap, 400 on bad JSON, undefined when no body. */
async function readJson<T>(c: Context, capBytes = 1_048_576): Promise<T | undefined | Response> {
  const reader = c.req.raw.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value!.byteLength;
    if (size > capBytes) {
      void reader.cancel().catch(() => undefined);
      return c.json({ error: "payload too large" }, 413);
    }
    chunks.push(value!);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
}

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

export interface ConciergeDeps {
  /** Platform seam override — tests inject a fake backend here; the
   *  default is the env-selected real one. */
  platform?: Platform;
}

export function buildApp(deps: ConciergeDeps = {}): { app: Hono } {
  const platform = deps.platform ?? createPlatform({
    backend: BACKEND as "docker" | "tinfoil",
    deployTag: DEPLOY_TAG,
    domainBase: DOMAIN_BASE,
  });

  const app = new Hono();
  app.use("*", cors({ origin: (process.env.CONCIERGE_ALLOWED_ORIGINS ?? "http://localhost:5173").split(",") }));
  app.onError((err, c) => {
    clog.error("unhandled route error", { err: String(err), path: c.req.path });
    return c.json({ error: "internal error" }, 500);
  });
  app.notFound((c) => c.json({ error: "not found" }, 404));

  const table = createTable(
    (instance) => {
      void platform.rest(instance)
        .then((detail) => clog.info("stop row fired", { instance, detail }))
        .catch((e) => clog.warn("stop row fired but failed", { instance, err: String(e) }));
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
          clog.info("wake row fired — deploy ok", { instance, jobId, detail });
        })
        .catch((e) => {
          const n = (wakeRetries.get(retryKey) ?? 0) + 1;
          if (n < 3) {
            wakeRetries.set(retryKey, n);
            table.setWake(instance, jobId, 2 * 60_000);
            clog.warn("wake deploy failed — row re-armed (+2min)", { instance, jobId, attempt: n, err: String(e) });
          } else {
            wakeRetries.delete(retryKey); // abandoned: a future occurrence starts fresh
            clog.error("wake deploy failed 3x — job abandoned (this occurrence)", { instance, jobId, err: String(e) });
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

  // ── User machines (the cattle spine — module semantics in
  // user-machines.ts). Names authorize the namespace exactly like
  // standby names: strict shape AND created/adopted here. The sub→name
  // map is memory-only; after a concierge reboot the hash embedded in
  // every name rebinds it from the platform list.
  const users = createUserMachines();
  const USER_NAME_RE = userNameRe();

  // ── Auth ─────────────────────────────────────────────────────────────────
  // Four tiers, one grep away:
  //   requireExternal  bb JWT or shared secret  (/boot/ready /status)
  //   requireJwtUser   bb JWT, returns its sub  (/boot — machines have no
  //                    user identity; the shared secret is NOT enough)
  //   requireSession   handshake-minted token   (/timer /handoff/post /handoff/post/pull)
  //   requireSecret    shared secret only       (/handshake bearer, /handoff, /handoff/pull)
  // The escrow routes are MACHINE verbs (arm at sleep, pull at boot — both
  // present the env shared secret) and they move the master secret: the
  // external tier — every waddle-app JWT holder — must never reach them
  // (review-caught: arm had no gate at all, pull only the fire window).

  /** Bearer token from a request header. */
  function bearer(c: Context): string | undefined {
    return c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
  }

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
  function authorize(token: string | undefined, instance: string | undefined): string | null {
    if (!token || !allowedInstance(instance)) return null;
    const e = table.entry(instance);
    if (e && token === e.sessionToken) {
      e.lastContact = Date.now();
      return instance;
    }
    return null;
  }

  /** External tier (bb JWT or shared secret). Replies 401 (returned as a
   *  Response) when the bearer does not pass; null = ok. */
  async function requireExternal(c: Context): Promise<Response | null> {
    if (await verifyExternal(bearer(c))) return null;
    return c.json({ error: "unauthorized" }, 401);
  }

  /** The user tier: a verified bb JWT, returning its `sub` as a string
   *  (or a 401/403 Response). The shared secret is a MACHINE identity —
   *  it names no user, so /boot refuses it (403, not 401: the bearer
   *  verified, it just isn't a user). */
  async function requireJwtUser(c: Context): Promise<Response | string> {
    const id = await verifyExternal(bearer(c));
    if (id?.kind === "jwt") return id.sub;
    return c.json({ error: id ? "user identity required — connect your store" : "unauthorized" }, id ? 403 : 401);
  }

  /** Session tier (handshake-minted token). Replies 401 (as a Response)
   *  when the bearer is not a live session for an allowed instance;
   *  otherwise the instance name. */
  function requireSession(c: Context, instance: string | undefined): Response | string {
    const resolved = authorize(bearer(c), instance);
    if (resolved === null) return c.json({ error: "unauthorized" }, 401);
    return resolved;
  }

  /** The machine tier: the shared secret only — escrow verbs and session
   *  minting move the master secret and must stay out of external reach. */
  function requireSecret(c: Context): Response | null {
    if (!secretOk(bearer(c), SHARED_SECRET)) return c.json({ error: "unauthorized" }, 401);
    return null;
  }

  /** No-store on every route that can return secrets or sealed mail. */
  function noStore(c: Context): void {
    c.header("cache-control", "no-store");
  }

  // ── Service ──────────────────────────────────────────────────────────────

  app.get("/health", async (c) =>
    c.json({
      service: "waddle-concierge",
      version: pkg.version,
      backend: BACKEND,
      rows: table.countRows(),
      // Counts only — standby NAMES authorize the standby namespace in
      // allowedInstance, so they are not published unauthenticated.
      pool: pool ? { size: POOL_SIZE, ttl_ms: STANDBY_TTL_MS, tracked: pool.tracked().length, demand_ms_ago: pool.demandMsAgo() } : { size: 0 },
    }));

  /** The user's discovery verb: "my machine, running". Idempotent, and
   *  the ONLY public path that mints user machines — first /boot tries a
   *  warm standby (seconds to live), then boots fresh (~90s). Later boots
   *  return the existing machine, ensured (user mode: a healthy Running
   *  machine is never stopped; a stopped one deploys). */
  app.post("/boot", async (c) => {
    const sub = await requireJwtUser(c);
    if (sub instanceof Response) return sub;
    const parsed = await readJson<BootRequest>(c);
    if (parsed instanceof Response) return parsed;
    const body = parsed ?? {};
    pool?.markDemand(); // any /boot is service use — arm pool warmth (scale-to-0 gate)
    // Observed-death wake: the client watched the old machine stop — its
    // name is dead weight in browser caches for up to the negative TTL;
    // a fresh mint sidesteps the poison entirely (blank machines are
    // cattle; the shelf holds all state).
    const wantFresh = body.fresh === true;
    if (wantFresh) {
      const old = users.rebind(sub);
      if (old) {
        users.retire(old); // tombstoned — the platform scan must not resurrect it
        void platform.destroy(old).catch(() => undefined); // DELETE: the user asked for fresh; the old machine is debris
        clog.info("boot: fresh requested — old name retired + destroyed", { user: hashSub(sub), instance: old });
      }
    }
    // Warm-first: a pool standby is already booted and measured — claiming
    // one saves the ~90s deploy. The claim-grace contract: a claimed
    // machine the user abandons dies within grace, not the pool TTL.
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
          clog.warn("boot: refusing stale-tag standby — destroying", { instance: got.name, tag, expected: STANDBY_CONFIG_TAG });
          await platform.destroy(got.name).catch(() => undefined);
          users.forget(got.name);
          table.forget(got.name);
        } else {
          users.claim(sub, got.name);
          table.setStop(got.name, CLAIM_GRACE_MS);
          void pool.tick().catch(() => undefined);
          name = got.name;
          clog.info("boot: claimed warm standby", { user: hashSub(sub), instance: name });
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
        table.forget(name);
        clog.warn("boot: create failed", { err: String(e) });
        return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
      }
      table.userWake(name);
      // The fresh-mint's OWN bound: a machine booted but never unlocked
      // cannot arm its own rows (identity-less — the sentinel 403s by
      // design), and the sweep's bound-skip would spare it forever as a
      // "claimed" machine. Same grace row as a warm claim: if the user
      // unlocks, the machine's own timer writes replace it; if they
      // abandon the boot, the row fires within grace (audit C1 — a
      // designed reaper that silently no-oped for this whole class).
      table.setStop(name, CLAIM_GRACE_MS);
      // Wait for Running via the platform API before handing out the URL:
      // the DNS record lands ~when the machine goes Running, and the
      // client's first /health poll must not query a record that doesn't
      // exist yet — that NXDOMAIN caches for the SOA negative TTL and the
      // machine is browser-unreachable for 30min from its own boot polls
      // (caught live 01:5xZ). Timeout still responds waking (honest — the
      // machine boots; a rare cert stall just means a slower client poll).
      const running = await platform.waitRunning(name, 180_000);
      const dns = running ? await platform.awaitDns(`${name}.${DOMAIN_BASE}`, 25_000) : false;
      clog.info("boot: fresh machine created", { user: hashSub(sub), instance: name, running, dns });
      return c.json(
        {
          instance: name,
          url: `https://${name}.${DOMAIN_BASE}`,
          status: "waking",
          detail: running ? "created (running)" : "created (still provisioning)",
        },
        202,
      );
    }
    // A user present means the machine should live: clear any pending
    // stop FIRST, then the claim-grace row lands last and sticks (an
    // abandoned warm claim dies on the grace clock; the machine's own
    // timer writes replace the row once the user actually unlocks).
    table.userWake(name);
    if (POOL_ENABLED && pool && STANDBY_NAME_RE.test(name)) table.setStop(name, CLAIM_GRACE_MS);
    // Stale-tag gate: a RUNNING machine on any tag but the current
    // release is dead weight — the client verifies against the LATEST
    // signed release and refuses it (live-proven: "Code measurement
    // mismatch", v0.0.51 vs a v0.0.50 user machine). Redeploy (the
    // treadmill dance); state is sealed + shelfed. The client's readiness
    // poll covers the ~90s.
    const row = (await platform.statusRows().catch(() => new Map())).get(name);
    const expectedTag = DEPLOY_TAG || STANDBY_CONFIG_TAG; // what deploys actually boot
    const staleTag = row?.status === "Running" && expectedTag && row.tag && row.tag !== expectedTag;
    try {
      const detail = staleTag
        ? await platform.redeploy(name)
        : await platform.ensure(name);
      if (staleTag) clog.info("boot: stale tag — redeployed", { instance: name, tag: row!.tag, expected: expectedTag });
      const dns = await platform.awaitDns(`${name}.${DOMAIN_BASE}`, 120_000).catch(() => false);
      const running = detail.startsWith("already running");
      clog.info("boot", { user: hashSub(sub), instance: name, detail, dns });
      return c.json(
        {
          instance: name,
          url: `https://${name}.${DOMAIN_BASE}`,
          status: running ? "running" : "waking",
          detail,
        },
        running ? 200 : 202,
      );
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
    }
  });

  /** The readiness poll (see sdk BootReadyResponse): the client asks the
   *  CONCIERGE — never the booting machine — until the machine is really
   *  reachable: Running + DNS live (c-ares, cache-free) + /health answers.
   *  Only then does the browser learn the machine's name, so its first
   *  query is a positive answer and no cache in its chain ever sees the
   *  name dead. */
  app.get("/boot/ready", async (c) => {
    const denied = await requireExternal(c);
    if (denied) return denied;
    const instance = c.req.query("instance");
    if (!instance || !allowedInstance(instance)) return c.json({ error: "instance not allowed" }, 403);
    // docker has no status feed (statuses() is empty) — discovery there is
    // dev-parity only; treat the machine as running once asked.
    if (BACKEND === "tinfoil") {
      const st = (await platform.statuses().catch(() => new Map())).get(instance);
      if (st !== "Running") return c.json({ instance, ready: false, why: "status" }, 503);
    }
    // NO /health probe leg: the concierge's egress cannot reach instance
    // hosts (firewall model — hostname allowlists can't express them). The
    // client probes /health itself once ready — by then the record is live,
    // so a slow agent is a connection refusal, never a cacheable NXDOMAIN.
    const dns = await platform.awaitDns(`${instance}.${DOMAIN_BASE}`, 6_000).catch(() => false);
    if (!dns) return c.json({ instance, ready: false, why: "dns" }, 503);
    return c.json({ instance, ready: true });
  });

  /** Handshake: betterbase JWT (or dev secret) → session token. Once per
   *  agent boot; re-running returns the SAME token (shared identity —
   *  the machine cannot tell a reboot from a re-handshake). */
  app.post("/handshake", async (c) => {
    const parsed = await readJson<HandshakeRequest>(c);
    if (parsed instanceof Response) return parsed;
    const body = parsed ?? ({} as HandshakeRequest);
    // CATTLE IDENTITY: the session's table key is resolved HERE, never
    // trusted from the body. Two tiers:
    //  - bb JWT + presented name: the caller's registry row must MATCH the
    //    name the client stated at unlock (two independent sources — the
    //    client's /boot and the concierge's registry — must agree).
    //    Mismatch = a stale or wrong machine talking: 409, re-boot. This
    //    is fail-closed by design; there is no mint-for-presented middle
    //    tier (the legacy fallback that needed it is deleted).
    //  - shared secret (autonomous boot, dev): the body name is validated
    //    against the known set; an autonomous boot passes the name its
    //    /handoff/pull taught it (the concierge's own record).
    const id = await verifyExternal(bearer(c));
    if (id?.kind === "jwt") {
      const resolved = users.rebind(id.sub);
      if (!resolved) return c.json({ error: "no machine for user — POST /boot first" }, 404);
      const presented = body.presented_instance;
      if (presented !== resolved) {
        clog.warn("handshake: presented name ≠ registry — refusing", { user: hashSub(id.sub), presented, resolved });
        return c.json({ error: "presented instance does not match the user's machine — re-boot" }, 409);
      }
      const sessionToken = table.mintSession(resolved);
      return c.json({ session_token: sessionToken, instance: resolved });
    }
    const { instance } = body;
    if (!allowedInstance(instance)) return c.json({ error: "instance not allowed" }, 403);
    // SECRET-ONLY fallback (autonomous boots, dev): machines hold the
    // shared secret. Constant-time, as everywhere the secret is compared.
    const denied = requireSecret(c);
    if (denied) return denied;
    const sessionToken = table.mintSession(instance);
    return c.json({ session_token: sessionToken, instance });
  });

  /** The table write. Replace semantics ARE the policy:
   *  stop rows are singleton-per-instance (debounce), wake rows are
   *  job-keyed one-shots. due_ms is relative (skew-immune); 0 cancels. */
  app.post("/timer", async (c) => {
    const parsed = await readJson<TimerRequest>(c);
    if (parsed instanceof Response) return parsed;
    const body = parsed ?? ({} as TimerRequest);
    const instance = requireSession(c, body.instance);
    if (instance instanceof Response) return instance;
    const { action, due_ms, job_id } = body;
    if (action !== "stop" && action !== "wake") return c.json({ error: "action must be stop|wake" }, 400);
    if (typeof due_ms !== "number" || due_ms < 0) return c.json({ error: "due_ms (ms from now, 0 to cancel) required" }, 400);

    if (action === "stop") {
      return c.json({ ok: true, stop: table.setStop(instance, due_ms) });
    }
    if (!job_id) return c.json({ error: "job_id required for wake rows" }, 400);
    return c.json({ ok: true, wake: table.setWake(instance, job_id, due_ms), job_id });
  });

  /** Operator/debug: the table, no secrets — but AUTHENTICATED (SME
   *  review): the snapshot names standby machines (names authorize the
   *  standby namespace), exposes schedule timing, and reveals when the
   *  escrow is armed. /health stays open with counts only. */
  app.get("/status", async (c) => {
    const denied = await requireExternal(c);
    if (denied) return denied;
    return c.json({
      now: Date.now(),
      instances: table.snapshot().map((e) => ({ ...e, wake_handoff: handoff.status(e.instance), postbox: postbox.status(e.instance) })),
    });
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
  app.post("/handoff", async (c) => {
    const parsed = await readJson<HandoffArmRequest>(c);
    if (parsed instanceof Response) return parsed;
    const { instance, credential, ttl_ms, clear } = parsed ?? ({} as HandoffArmRequest);
    if (!allowedInstance(instance)) return c.json({ error: "instance not allowed" }, 403);
    const denied = requireSecret(c);
    if (denied) return denied;
    noStore(c);
    if (clear) {
      handoff.clear(instance);
      clog.info("wake handoff disarmed", { instance });
      return c.json({ ok: true, cleared: true });
    }
    if (!credential || typeof credential !== "object" || Object.keys(credential).length === 0) {
      return c.json({ error: "credential payload required (non-empty)" }, 400);
    }
    const res = handoff.arm(instance, credential, ttl_ms);
    clog.info("wake handoff armed (memory-only)", { instance, expires_in_ms: res.expires_in_ms, keys: Object.keys(credential) });
    return c.json({ ok: true, ...res });
  });

  /** Pull the wake handoff: a just-booted locked machine asks for its
   *  credential. POST (never GET — no caching, no URL-borne secrets) and
   *  the fire-gate is the whole security story: a boot that the concierge
   *  did not successfully deploy for a schedule gets 404 and stays a
   *  normal locked ceremony. */
  app.post("/handoff/pull", async (c) => {
    const parsed = await readJson<HandoffPullRequest>(c);
    if (parsed instanceof Response) return parsed;
    const { instance } = parsed ?? ({} as HandoffPullRequest);
    // Secret FIRST — every pull is a machine-side call.
    const denied = requireSecret(c);
    if (denied) return denied;
    noStore(c);
    // CATTLE FALLBACK (k=1): a wake boot can't know its own name — it
    // presents the baked sentinel ("unadopted", in NO dynamic namespace)
    // under the legacy shared key. Only such a caller gets the fallback,
    // and it MUST bypass the name gate (the gate would 403 exactly the
    // caller the fallback exists for) — with exactly one fire window
    // open anywhere, that fire's boot is this puller. A caller that DOES
    // present a real shape gets the name gate + exact-key semantics
    // only. k>1 ambiguity denies (platform ask).
    const legacyCaller = typeof instance === "string" && !USER_NAME_RE.test(instance) && !STANDBY_NAME_RE.test(instance);
    if (!legacyCaller && !allowedInstance(instance)) return c.json({ error: "instance not allowed" }, 403);
    const res = handoff.release(instance);
    if ("notFound" in res) {
      const open = legacyCaller ? handoff.singleOpenWindow() : null;
      if (open) {
        const via = handoff.release(open);
        if (!("notFound" in via)) {
          clog.info("wake handoff pull resolved via open fire window", { asked: instance, serving: open });
          return c.json({ credential: via.cred, instance: open });
        }
      }
      clog.info("wake handoff pull denied", { instance, reason: res.reason });
      return c.json({ error: `no handoff (${res.reason})` }, 404);
    }
    clog.info("wake handoff released to schedule-boot", { instance, armed_ms_ago: res.armed_ms_ago, keys: Object.keys(res.cred) });
    return c.json({ credential: res.cred, instance });
  });

  /** Post a sealed blob — an autonomous machine's return mail at re-sleep.
   *  The blob is AEAD ciphertext (instance-bound AAD, sealed under a key
   *  derived from the master secret): the concierge holds mail it cannot
   *  open. External-tier auth is fine — a forged row is undecryptable
   *  junk, not a credential. */
  // 8MiB cap on THIS route only (the default elsewhere — a raise is an
  // unauthenticated buffering surface; the postbox carries one run's sealed
  // tail, client-capped at 200 events).
  app.post("/handoff/post", async (c) => {
    const parsed = await readJson<PostboxPostRequest>(c, 8 * 1024 * 1024);
    if (parsed instanceof Response) return parsed;
    // SESSION tier (like /timer): both writers — the autonomous machine at
    // re-sleep and the unlocking machine at collection — handshook first.
    // A bearer confusion here (session token sent to an external-tier
    // endpoint) once 401'd AND killed the sender's session (review finding).
    const instance = requireSession(c, parsed?.instance);
    if (instance instanceof Response) return instance;
    noStore(c);
    const { blob, clear } = parsed ?? ({} as PostboxPostRequest);
    if (clear) {
      postbox.clear(instance);
      return c.json({ ok: true, cleared: true });
    }
    if (typeof blob !== "string" || !blob) return c.json({ error: "blob required" }, 400);
    const res = postbox.post(instance, blob);
    clog.info("postbox stored (sealed)", { instance, bytes: blob.length, expires_in_ms: res.expires_in_ms });
    return c.json({ ok: true, ...res });
  });

  /** Pull the postbox: the machine at the next unlock (which can derive the
   *  seal key) collects and clears the mail. One delivery. */
  app.post("/handoff/post/pull", async (c) => {
    const parsed = await readJson<PostboxPullRequest>(c);
    if (parsed instanceof Response) return parsed;
    const instance = requireSession(c, parsed?.instance); // session tier — see /handoff/post
    if (instance instanceof Response) return instance;
    noStore(c);
    const blob = postbox.pull(instance);
    if (blob === null) return c.json({ error: "no mail" }, 404);
    clog.info("postbox delivered (pull-and-clear)", { instance, bytes: blob.length });
    return c.json({ blob });
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
            // End-of-life is DELETE (a stopped machine is platform debris);
            // the platform verb owns rest-then-delete. Errors PROPAGATE —
            // the pool retries a failed destroy with the name still held
            // (destroyMachine's contract); the name frees on every outcome.
            try {
              await platform.destroy(name);
            } finally {
              poolNames.delete(name);
            }
          },
          // UNKNOWN ≠ DEAD (audit I7): a thrown `container list` (CLI
          // timeout, API 5xx) must not read as "every warm machine is
          // unhealthy" — the tick would destroy the whole pool on one
          // blip. Errors propagate; tick skips reaping unknown machines.
          health: async (name) => {
            const statuses = await platform.statuses();
            const st = statuses.get(name);
            if (st === undefined) return undefined; // unknown this pass
            return st === "Running";
          },
          urlFor: (name) => `https://${name}.${DOMAIN_BASE}`,
          tagOf: async (name) => {
            const rows = await platform.statusRows();
            const row = rows.get(name);
            if (row === undefined) return undefined; // unknown ≠ stale
            return row.tag;
          },
          nextName: () => {
            for (let i = 1; ; i++) {
              const n = `${STANDBY_PREFIX}${i}`;
              if (!poolNames.has(n)) return n;
            }
          },
          now: () => Date.now(),
          log: (msg, fields) => clog.info(msg, fields ?? {}),
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
            else clog.info("pool: leftover not adoptable yet", { name: n, status: st });
          }
          if (stopped.length > 0) pool.adopt(stopped);
          if (running.length > 0) pool.adoptForeign(running);
          clog.info("pool: platform standby scan", { adopted_stopped: stopped.length, adopted_running_foreign: running.length });
          void pool.tick();
        })
        .catch((e) => clog.warn("pool scan failed — retrying next interval", { err: String(e) }));
    void scanLeftovers();
    setInterval(() => void scanLeftovers(), envInt("POOL_SCAN_MS", 5 * 60_000, 10_000)).unref();
    if (POOL_ENABLED) {
      setInterval(() => void pool.tick().catch((e) => clog.warn("pool tick failed", { err: String(e) })), envInt("POOL_TICK_MS", 30_000, 1_000)).unref();
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
          if (adopted > 0) clog.info("user machines adopted from platform", { adopted });
          // ORPHAN JANITOR — the shared cleanup backstop. Every lifecycle
          // path funnels destruction through platform.destroy, but any
          // USER-machine that slips (a failed destroy, a forgot stray)
          // ends up here: in OUR namespace, owned by no live bookkeeping.
          // Standby names are EXCLUDED — the pool owns that namespace
          // end-to-end (scanLeftovers adopts stock → TTL/claim-grace
          // destroys); racing it here could delete warm stock (review
          // finding). users.adopt ran above, same synchronous block —
          // inherited sleepers are in known() before this loop sees them.
          const spared = new Set([...users.known(), ...ALLOWED]);
          for (const name of statuses.keys()) {
            if (USER_NAME_RE.test(name) && !spared.has(name)) {
              clog.warn("janitor: orphan user machine — destroying", { instance: name });
              void platform
                .destroy(name)
                .then(() => {
                  users.forget(name);
                  table.forget(name);
                })
                .catch(() => undefined); // retried next scan
            }
          }
        })
        .catch(() => undefined); // retried next interval
    void scanUsers();
    setInterval(() => void scanUsers(), envInt("POOL_SCAN_MS", 5 * 60_000, 10_000)).unref();
  }

  // ── Backstop sweep: bound machines gone quiet get DESTROYED ───────────
  // Covers missed death-flares and our own post-reboot amnesia. Scoped to
  // ALLOWED — never the whole docker host or platform account.
  setInterval(
    () => {
      void (async () => {
        const names = await platform.list().catch((e) => {
          clog.warn("backstop list failed", { err: String(e) });
          return [] as string[];
        });
        const bound = users.boundNames();
        for (const name of names) {
          if (!allowedInstance(name) || bound.has(name)) continue; // an owner is present — the machine's own idle gate owns it
          if (POOL_ENABLED && poolNames.has(name)) continue; // pool stock — the pool's own TTL/health owns it
          const e = table.entry(name);
          const adopted = users.adoptedAt(name);
          if (!e && !adopted) continue; // neither seen nor inherited — not ours to reap
          // Two quiet clocks, one outcome: a machine we've SEEN go quiet
          // (table lastContact), or a sleeper we INHERITED at a restart
          // (adoption time) that nobody has re-bound since. Both mean
          // abandoned — DELETE (a stopped machine is platform debris,
          // overnight graveyard live-caught). Nothing unique is lost: the
          // shelf is the state (proof 10: fresh mint + shelf restore); the
          // tombstone blocks scan re-adoption of the dead name.
          const quietMs = e ? Date.now() - e.lastContact : Date.now() - adopted;
          if (quietMs < HARD_STOP_MS) continue;
          clog.info("backstop: destroying abandoned managed instance", { instance: name, quiet_ms: quietMs });
          await platform.destroy(name).catch((err) => clog.warn("backstop destroy failed", { err: String(err) }));
          users.retire(name);
          users.forget(name);
          table.forget(name); // ghost rows outlive the machine otherwise
        }
      })();
    },
    envInt("CONCIERGE_SWEEP_MS", 15 * 60_000, 10_000),
  ).unref();

  return { app };
}
