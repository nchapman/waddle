/**
 * Platform verbs — the only module that shells out (docker | tinfoil).
 * Selected once at boot; everything else talks to the Platform seam.
 * Backends are ~25 lines each by design: a seam, not a code fork.
 */
import { execFile } from "node:child_process";
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
  /** Every instance name the backend knows. */
  list(): Promise<string[]>;
  /** Health-first start: a machine the platform reports Running needs
   *  nothing — the naive path would run the zombie stop-deploy dance on
   *  a healthy machine. "Running" is verified, not trusted: the probe
   *  polls the public /health for up to `probeMs` (a booting replacement
   *  gets its ~90s to reach health), then a silent machine is treated
   *  as the zombie it is — stop + redeploy, the release window still
   *  open for the boot this fire intended. */
  ensure(instance: string, probeMs?: number): Promise<string>;
}

/** Last few lines of CLI output, pipe-joined — deploy details for logs. */
const tail = (s: string, n = 3): string => s.trim().split("\n").slice(-n).join(" | ");

export function createPlatform(opts: {
  backend: "docker" | "tinfoil";
  deployTag?: string;
  exec?: Exec;
  probe?: Probe;
  /** The zone instance domains live under (INSTANCE_DOMAIN_BASE) — the
   *  probe fallback when a `container list` row lacks its DOMAIN column. */
  domainBase?: string;
}): Platform {
  const { backend, deployTag } = opts;
  const exec = opts.exec ?? realExec;
  const probe = opts.probe ?? realProbe;
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
  async function listRows(): Promise<Map<string, { status: string; domain?: string }>> {
    if (statusCache && Date.now() - statusCache.at < 10_000) return statusCache.rows;
    const { stdout } = await exec("tinfoil", ["container", "list"], { timeout: 60_000 });
    const rows = new Map<string, { status: string; domain?: string }>();
    // Header row then one row per instance: NAME STATUS DOMAIN TAG REPO.
    // A domain carries a dot; a drifted/absent column must not smuggle
    // the TAG in as a probe host.
    for (const line of stdout.split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      const domain = cols[2] && cols[2].includes(".") ? cols[2] : undefined;
      if (cols.length >= 2 && cols[0] && cols[0] !== "NAME") rows.set(cols[0]!, { status: cols[1]!, domain });
    }
    statusCache = { at: Date.now(), rows };
    return rows;
  }

  async function statuses(): Promise<Map<string, string>> {
    const rows = await listRows();
    return new Map([...rows].map(([name, r]) => [name, r.status]));
  }

  async function list(): Promise<string[]> {
    return [...(await listRows()).keys()];
  }

  /** Running must mean REACHABLE: poll the public /health for up to
   *  probeMs (default 10s; the wake-row fire path gives a booting
   *  replacement its ~90s). A machine that stays silent is a zombie —
   *  fall through to start(), whose 409 dance stops and redeploys it
   *  while the fire's release window is still open. A Running machine
   *  with no derivable domain is trusted, never stopped — the deploy
   *  path's 409 dance would stop a live machine we merely can't probe. */
  async function ensure(instance: string, probeMs = 10_000): Promise<string> {
    try {
      const row = (await listRows()).get(instance);
      if (row?.status === "Running") {
        const domain = row.domain ?? (domainBase ? `${instance}.${domainBase}` : undefined);
        if (!domain) return `already running (no domain — probe skipped): ${instance}`;
        const url = `https://${domain}`;
        const deadline = Date.now() + probeMs;
        do {
          if (await probe(url, 5_000)) return `already running (healthy): ${instance}`;
          await new Promise((r) => setTimeout(r, Math.min(5_000, Math.max(0, deadline - Date.now()))));
        } while (Date.now() < deadline);
        // Silent for the whole budget: a booting replacement that never
        // reached health, or a dead agent under a Running status.
        return start(instance);
      }
    } catch {
      /* status unknown — fall through to the deploy path */
    }
    return start(instance);
  }

  return { start, rest, statuses, list, ensure };
}
