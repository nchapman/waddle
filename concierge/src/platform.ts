/**
 * Platform verbs — the only module that shells out (docker | tinfoil).
 * Selected once at boot; everything else talks to the Platform seam.
 * Backends are ~25 lines each by design: a seam, not a code fork.
 */
import { execFile } from "node:child_process";
import { resolve4 as realResolve4 } from "node:dns/promises";
import { promisify } from "node:util";

/** One shell-out. Injectable so tests pin the CLI-output contracts. */
export type Exec = (
  cmd: string,
  args: readonly string[],
  opts?: { timeout?: number },
) => Promise<{ stdout: string }>;
const realExec = promisify(execFile) as Exec;

/** A reachability probe against the instance's public /health. */
export type Probe = (url: string, timeoutMs: number) => Promise<boolean>;
const realProbe: Probe = async (url, timeoutMs) => {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
};

export interface Platform {
  /** Deploy/start an instance (zombie-recovering on tinfoil). */
  start(instance: string): Promise<string>;
  /** Idempotent stop — already-stopped is success. */
  rest(instance: string): Promise<string>;
  /** Status by instance name, memoized ~10s (tinfoil only) — the pool,
   *  the leftover scan, and the backstop sweep share one `container
   *  list` per tick. Empty map on docker. */
  statuses(): Promise<Map<string, string>>;
  /** Status + deployed tag per instance (the pool's stale-tag reap and
   *  /boot's warm-claim gate read the tag from here). */
  statusRows(): Promise<Map<string, { status: string; tag?: string }>>;
  /** Every instance name the backend knows. */
  list(): Promise<string[]>;
  /** Health-first start, mode-aware (see the tinfoil implementation):
   *  "user" (default) never stops a Running machine on a failed probe;
   *  "fire" (wake rows) stop+redeploys a silent one while its release
   *  window is open. */
  ensure(instance: string, probeMs?: number, mode?: "user" | "fire"): Promise<string>;
  /** Stop-then-deploy at the configured tag (stale-tag recovery). */
  redeploy(instance: string): Promise<string>;
  /** Stop-then-DELETE (end-of-life — stopped machines are debris). */
  destroy(instance: string): Promise<string>;
  /** Wait via the platform API (NO DNS) until the instance reports
   *  Running — a fresh machine's DNS record lands ~when it goes Running,
   *  and handing the client the URL earlier lets its /health polls cache
   *  NXDOMAIN for the not-yet-existing record (the boot-window poison
   *  class, caught live 2026-10-11). False on timeout — the caller
   *  reports honestly; the machine still boots. */
  waitRunning(instance: string, timeoutMs?: number): Promise<boolean>;
  /** Poll DNS (c-ares — NO local cache) until the instance's hostname
   *  resolves. The platform re-adds a stopped machine's record some
   *  seconds AFTER the deploy CLI returns / Running flips — a client
   * handed the URL in that gap poisons ITS OWN resolver cache with
   *  NXDOMAIN for the SOA negative TTL (caught live twice 02:30Z:
   *  Chrome, and before it the local chain). False on timeout — the
   *  caller reports honestly. */
  awaitDns(host: string, timeoutMs?: number): Promise<boolean>;
  /** One /health probe (bounded) — the readiness endpoint's final check. */
  probe(url: string, timeoutMs?: number): Promise<boolean>;
}

/** Last few lines of CLI output, pipe-joined — deploy details for logs. */
const tail = (s: string, n = 3): string => s.trim().split("\n").slice(-n).join(" | ");

export function createPlatform(opts: {
  backend: "docker" | "tinfoil";
  deployTag?: string;
  exec?: Exec;
  probe?: Probe;
  /** Override the DNS lookup (tests); default is c-ares resolve4 —
   *  cache-free, unlike getaddrinfo. */
  resolve?: (host: string) => Promise<string[]>;
  /** The zone instance domains live under (INSTANCE_DOMAIN_BASE) — the
   *  probe fallback when a `container list` row lacks its DOMAIN column. */
  domainBase?: string;
}): Platform {
  const { backend, deployTag } = opts;
  const exec = opts.exec ?? realExec;
  const probe = opts.probe ?? realProbe;
  const resolve4 = opts.resolve ?? realResolve4;
  const domainBase = opts.domainBase ? opts.domainBase.replace(/^\.+/, "") : "";

  if (backend === "docker") {
    const start = async (instance: string): Promise<string> => {
      await exec("docker", ["start", instance], { timeout: 120_000 });
      return `docker:${instance} started`;
    };
    const rest = async (instance: string): Promise<string> => {
      await exec("docker", ["stop", instance], { timeout: 120_000 });
      return `docker:${instance} stopped`;
    };
    return {
      start,
      rest,
      statuses: () => Promise.resolve(new Map()), // no status feed needed on docker
      async list() {
        const { stdout } = await exec("docker", ["ps", "-a", "--format", "{{.Names}}"], { timeout: 60_000 });
        return stdout.split("\n").map((s) => s.trim()).filter(Boolean);
      },
      ensure: (instance: string) => start(instance), // docker start is already health-agnostic
      redeploy: (instance: string) => start(instance), // docker has no tags — a restart is the dance
      destroy: async (instance: string) => {
        await exec("docker", ["rm", "-f", instance], { timeout: 60_000 });
        return "removed";
      },
      waitRunning: (instance: string) => start(instance).then(() => true, () => false), // docker start is synchronous
      awaitDns: () => Promise.resolve(true), // docker-local hosts resolve via /etc/hosts — nothing to wait for
      probe, // the injected/real probe — same reachability check as tinfoil
      statusRows: () => Promise.resolve(new Map()), // docker has no tag feed
    };
  }

  // tinfoil: deploy boots a stopped instance with its measured config.
  // Needs the CLI on PATH + TINFOIL_ADMIN_KEY in env (container build
  // concern — see the Dockerfile). Deploy WITH the configured tag: a
  // tagless deploy re-boots the instance's SAVED tag — version skew the
  // client's latest-release verification correctly refuses.
  const deployArgs = (instance: string) =>
    deployTag ? ["container", "deploy", instance, "--tag", deployTag] : ["container", "deploy", instance];

  async function start(instance: string): Promise<string> {
    try {
      const { stdout } = await exec("tinfoil", deployArgs(instance), { timeout: 120_000 });
      return tail(stdout);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Zombie: the agent idle-exited but the instance still reads Running —
      // deploy 409s. Stop, wait it out, deploy. (Live-verified sequence; a
      // same-tag update also works but needs the tag to exist.)
      if (msg.includes("cannot deploy a running instance")) {
        await rest(instance);
        for (let i = 0; i < 30; i++) {
          await new Promise((r) => setTimeout(r, 2_000));
          try {
            const { stdout } = await exec("tinfoil", deployArgs(instance), { timeout: 120_000 });
            return "(zombie recovered) " + tail(stdout, 2);
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

  async function rest(instance: string): Promise<string> {
    try {
      const { stdout } = await exec("tinfoil", ["container", "stop", instance], { timeout: 120_000 });
      return tail(stdout);
    } catch (e) {
      // Already stopped (or stopping) is success for an idempotent stop.
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("is not running") || msg.includes("already")) return `already stopped: ${instance}`;
      throw e;
    }
  }

  let statusCache: { at: number; rows: Map<string, { status: string; domain?: string }> } | null = null;
  async function listRows(): Promise<Map<string, { status: string; domain?: string; tag?: string }>> {
    if (statusCache && Date.now() - statusCache.at < 10_000) return statusCache.rows;
    const { stdout } = await exec("tinfoil", ["container", "list"], { timeout: 60_000 });
    const rows = new Map<string, { status: string; domain?: string; tag?: string }>();
    // Header row then one row per instance: NAME STATUS DOMAIN TAG REPO.
    // Column-shape guard: a domain's LAST label is alphabetic (example.dev)
    // — a dotted TAG (v0.3.18) must never smuggle in as a probe host.
    const looksLikeDomain = (s: string | undefined): s is string =>
      !!s && s.includes(".") && /^[a-z]{2,}$/i.test(s.split(".").pop() ?? "");
    for (const line of stdout.split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      const domain = looksLikeDomain(cols[2]) ? cols[2] : undefined;
      // TAG: vNNN.N.N shape when the DOMAIN column is present, else the
      // dotted-column guard already rejected it — take the first
      // vN.N-shaped column.
      const tag = cols.find((c, i) => i >= 2 && /^v\d+\.\d+/.test(c ?? ""));
      if (cols.length >= 2 && cols[0] && cols[0] !== "NAME") rows.set(cols[0]!, { status: cols[1]!, domain, tag });
    }
    statusCache = { at: Date.now(), rows };
    return rows;
  }

  /** Status + tag per instance (memoized with the same cache). */
  async function statusRows(): Promise<Map<string, { status: string; tag?: string }>> {
    return listRows();
  }

  async function statuses(): Promise<Map<string, string>> {
    const rows = await listRows();
    return new Map([...rows].map(([name, r]) => [name, r.status]));
  }

  async function list(): Promise<string[]> {
    return [...(await listRows()).keys()];
  }

  /** Health-first start, two modes:
   *
   *  "fire" (wake-row): a silent Running machine IS the lost-work
   *  incident — stop+redeploy it while the release window is open. The
   *  409 dance is the recovery; failed deploys re-arm on their retry
   *  budget.
   *
   *  "user" (/wake): non-destructive by default. A failed probe cannot
   *  distinguish a dead agent from egress-blocking-the-probe, and the
   *  client polls /health itself either way — so a silent machine is
   *  reported, never stopped. A true zombie degrades to today's
   *  behavior (client's poll times out) instead of risking a stop of a
   *  live, possibly unlocked machine. */
  async function ensure(instance: string, probeMs = 10_000, mode: "user" | "fire" = "user"): Promise<string> {
    let row: { status: string; domain?: string } | undefined;
    try {
      row = (await listRows()).get(instance);
    } catch {
      /* status unknown — fall through to the deploy path */
    }
    if (row?.status === "Running") {
      const domain = row.domain ?? (domainBase ? `${instance}.${domainBase}` : undefined);
      if (!domain) return `already running (no domain — probe skipped): ${instance}`;
      const url = `https://${domain}`;
      const deadline = Date.now() + probeMs;
      let healthy = false;
      do {
        healthy = await probe(url, 5_000);
        if (healthy) return `already running (healthy): ${instance}`;
        await new Promise((r) => setTimeout(r, Math.min(5_000, Math.max(0, deadline - Date.now()))));
      } while (Date.now() < deadline);
      if (mode === "user") {
        return `already running (probe failed — left running): ${instance}`;
      }
      // Fire mode: silent past the budget — a booting replacement that
      // never reached health, or a dead agent under a Running status.
      return start(instance);
    }
    return start(instance);
  }

  /** Stop-then-DELETE an instance — the only honest end-of-life (a
   *  stopped machine is platform debris: it lingers in every list, scan
   *  and dashboard forever; live-caught as an overnight graveyard of
   *  proof/retired machines). Blank stock and abandoned sleepers have no
   *  unique state — the shelf is the state (proof 10: fresh mint + shelf
   *  restore). */
  async function destroy(instance: string): Promise<string> {
    await rest(instance).catch(() => undefined);
    try {
      const { stdout } = await exec("tinfoil", ["container", "delete", instance], { timeout: 60_000 });
      return tail(stdout);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/not found|no such/i.test(msg)) return "(already gone)";
      throw e;
    }
  }

  async function waitRunning(instance: string, timeoutMs = 240_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    do {
      const st = (await listRows().catch(() => new Map<string, { status?: string }>())).get(instance)?.status;
      if (st === "Running") return true;
      await new Promise((r) => setTimeout(r, 5_000));
    } while (Date.now() < deadline);
    return false;
  }

  /** Distinguish "the record is not there" (ENOTFOUND/ENODATA — keep
   *  waiting) from "I cannot ask" (transient resolver codes — EAI_AGAIN,
   *  ETIMEOUT, ECONNREFUSED — the runtime egress allowlist may not carry
   *  DNS; treat as live and let the platform's Running status carry the
   *  signal). Any OTHER code is also fail-open — a fail-closed gate on
   *  an unexpected error bricks every boot. */
  async function dnsLive(host: string): Promise<boolean> {
    try {
      return (await resolve4(host)).length > 0;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code === "ENOTFOUND" || code === "ENODATA") return false;
      return true; // EAI_AGAIN / ETIMEOUT / blocked — cannot tell
    }
  }

  async function awaitDns(host: string, timeoutMs = 30_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    do {
      if (await dnsLive(host)) return true;
      await new Promise((r) => setTimeout(r, 3_000));
    } while (Date.now() < deadline);
    return false;
  }

  /** Stop-then-deploy at the configured tag (the treadmill dance). A
   *  RUNNING machine on a stale tag is dead weight: every client verifies
   *  against the LATEST signed release and refuses it (live-proven:
   *  "Code measurement mismatch"). State is sealed + shelfed; the
   *  redeploy is recovery, not loss. start() owns the stop-settle
   *  polling (its zombie path). */
  async function redeploy(instance: string): Promise<string> {
    await rest(instance).catch(() => undefined);
    // Settle: the platform accepts deploy only once the stop has LANDED
    // (live-caught: deploy at "Stopping" 502s with a different error than
    // start()'s zombie-retry matches). Bounded wait, then start() owns
    // any residual race.
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const st = (await listRows().catch(() => new Map<string, { status?: string }>())).get(instance)?.status;
      if (st === "Stopped" || st === undefined) break;
      await new Promise((r) => setTimeout(r, 3_000));
    }
    return start(instance);
  }

  return { start, rest, destroy, statuses, statusRows, list, ensure, redeploy, waitRunning, awaitDns, probe: (url, ms) => probe(url, ms ?? 5_000) };
}
