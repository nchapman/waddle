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
   *  nothing — the naive path would run the zombie stop-deploy dance on a
   *  healthy machine. Residual (accepted, live-verified): a zombie (agent
   *  dead, platform still reads Running) short-circuits too, and the
   *  occurrence is consumed with no boot — tight fire booking at sleep
   *  (≤ replacement-deploy cadence) is the standing mitigation. */
  ensure(instance: string): Promise<string>;
}

/** Last few lines of CLI output, pipe-joined — deploy details for logs. */
const tail = (s: string, n = 3): string => s.trim().split("\n").slice(-n).join(" | ");

export function createPlatform(opts: {
  backend: "docker" | "tinfoil";
  deployTag?: string;
  exec?: Exec;
}): Platform {
  const { backend, deployTag } = opts;
  const exec = opts.exec ?? realExec;

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
      ensure: start,
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

  let statusCache: { at: number; map: Map<string, string> } | null = null;
  async function statuses(): Promise<Map<string, string>> {
    if (statusCache && Date.now() - statusCache.at < 10_000) return statusCache.map;
    const { stdout } = await exec("tinfoil", ["container", "list"], { timeout: 60_000 });
    const map = new Map<string, string>();
    // Header row then one row per instance; the name is the first column.
    for (const line of stdout.split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length >= 2 && cols[0] && cols[0] !== "NAME") map.set(cols[0]!, cols[1]!);
    }
    statusCache = { at: Date.now(), map };
    return map;
  }

  async function list(): Promise<string[]> {
    return [...(await statuses()).keys()];
  }

  async function ensure(instance: string): Promise<string> {
    try {
      if ((await statuses()).get(instance) === "Running") return `already running: ${instance}`;
    } catch {
      /* status unknown — fall through to the deploy path */
    }
    return start(instance);
  }

  return { start, rest, statuses, list, ensure };
}
