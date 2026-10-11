import { test } from "node:test";
import assert from "node:assert/strict";
import { createPlatform, type Exec } from "./platform.js";

const LIST_OUTPUT = [
  "NAME                 STATUS      DOMAIN                                  TAG     REPO",
  "waddle               Running     waddle.ddg.example.dev                   v1      r/r",
  "waddle-standby-1     Stopped     waddle-standby-1.ddg.example.dev         v1      r/r",
  "other-account-thing  Running     other.ddg.example.dev                   v1      r/r",
].join("\n");

/** exec stub: match on `cmd args…` prefix; return stdout or throw. */
function fakeExec(routes: Array<{ args: string[]; stdout?: string; err?: string }>): {
  calls: string[][];
  exec: Exec;
} {
  const calls: string[][] = [];
  const exec: Exec = async (_cmd, args) => {
    const argv = [...args];
    calls.push(argv);
    const route = routes.find((r) => r.args.every((a, i) => argv[i] === a));
    if (!route) throw new Error(`unexpected exec: ${argv.join(" ")}`);
    if (route.err) throw new Error(route.err);
    return { stdout: route.stdout ?? "" };
  };
  return { calls, exec };
}

const tinfoil = (
  exec: Exec,
  deployTag = "v1",
  probe?: (url: string, timeoutMs: number) => Promise<boolean>,
) => createPlatform({ backend: "tinfoil", deployTag, exec, probe });

test("statuses parses `container list` (header skipped, name → status)", async () => {
  const { exec } = fakeExec([{ args: ["container", "list"], stdout: LIST_OUTPUT }]);
  const st = await tinfoil(exec).statuses();
  assert.equal(st.get("waddle"), "Running");
  assert.equal(st.get("waddle-standby-1"), "Stopped");
  assert.equal(st.size, 3);
});

test("statuses memoizes — one `container list` per tick", async () => {
  let n = 0;
  const exec: Exec = async () => ({ stdout: n++ === 0 ? LIST_OUTPUT : "should not be called" });
  const p = tinfoil(exec);
  await p.statuses();
  await p.statuses();
  assert.equal(n, 1);
});

test("list (tinfoil) is the statuses map's keys — the sweep shares the cache", async () => {
  const { exec } = fakeExec([{ args: ["container", "list"], stdout: LIST_OUTPUT }]);
  const p = tinfoil(exec);
  assert.deepEqual(await p.list(), ["waddle", "waddle-standby-1", "other-account-thing"]);
});

test("ensure short-circuits on Running+healthy — no deploy on a healthy machine", async () => {
  const { calls, exec } = fakeExec([{ args: ["container", "list"], stdout: LIST_OUTPUT }]);
  const probed: string[] = [];
  const probe = async (url: string) => {
    probed.push(url);
    return true;
  };
  const detail = await tinfoil(exec, "v1", probe).ensure("waddle");
  assert.match(detail, /already running \(healthy\)/);
  assert.deepEqual(probed, ["https://waddle.ddg.example.dev"]);
  assert.ok(!calls.some((c) => c.includes("deploy")), "no deploy was attempted");
});

test("fire mode treats a silent Running machine as a zombie: probe, then redeploy", async () => {
  // Platform says Running, /health never answers. The fire's work must
  // still happen: stop the zombie, redeploy (the 18:43Z incident class).
  const deploys: string[][] = [];
  const exec: Exec = async (_c, args) => {
    deploys.push([...args]);
    if (args[1] === "deploy" && deploys.filter((a) => a[1] === "deploy").length === 1) {
      throw new Error("cannot deploy a running instance"); // the 409 the zombie throws
    }
    if (args[1] === "list") return { stdout: LIST_OUTPUT };
    return { stdout: "ok" };
  };
  const detail = await tinfoil(exec, "v1", async () => false).ensure("waddle", 1, "fire");
  assert.match(detail, /zombie recovered/);
  // list, deploy(409), stop, deploy — the zombie dance ran before the recovery deploy
  assert.deepEqual(deploys[2], ["container", "stop", "waddle"]);
});

test("user mode NEVER stops a silent Running machine — a failed probe is reported, not acted on", async () => {
  // The client polls /health itself; a probe failure from inside the
  // concierge cannot distinguish a dead agent from blocked egress, so
  // the destructive dance is reserved for fires.
  const { calls, exec } = fakeExec([{ args: ["container", "list"], stdout: LIST_OUTPUT }]);
  const detail = await tinfoil(exec, "v1", async () => false).ensure("waddle", 1);
  assert.match(detail, /probe failed — left running/);
  assert.ok(!calls.some((c) => c.includes("deploy") || c.includes("stop")));
});

test("a deploy failure propagates — never swallowed into a second deploy", async () => {
  let deploys = 0;
  const exec: Exec = async (_c, args) => {
    if (args[1] === "list") throw new Error("CLI broke");
    if (args[1] === "deploy") {
      deploys++;
      throw new Error("quota exceeded");
    }
    throw new Error("unexpected");
  };
  await assert.rejects(() => tinfoil(exec).ensure("waddle"), /quota exceeded/);
  assert.equal(deploys, 1, "exactly one deploy attempt");
});

test("ensure keeps probing within its budget — a slow boot is not a zombie", async () => {
  const { calls, exec } = fakeExec([{ args: ["container", "list"], stdout: LIST_OUTPUT }]);
  let n = 0;
  const probeCalls: string[] = [];
  const probe = async (url: string) => {
    probeCalls.push(url);
    return ++n >= 2; // healthy on the second probe
  };
  const detail = await tinfoil(exec, "v1", probe).ensure("waddle", 60_000);
  assert.match(detail, /already running \(healthy\)/);
  assert.equal(probeCalls.length, 2);
  assert.ok(!calls.some((c) => c.includes("deploy")), "no deploy was attempted");
});

// A column-drifted `container list`: no DOMAIN column — and a DOTTED
// TAG (v0.3.18) sitting exactly where a domain would be.
const LIST_NO_DOMAIN = [
  "NAME      STATUS   TAG       REPO",
  "waddle    Running  v0.3.18   r/r",
].join("\n");

test("ensure derives the probe URL from the zone when the DOMAIN column goes missing", async () => {
  // Column drift must never turn into stop+redeploy of a live machine.
  const { calls, exec } = fakeExec([{ args: ["container", "list"], stdout: LIST_NO_DOMAIN }]);
  const probed: string[] = [];
  const detail = await createPlatform({ backend: "tinfoil", deployTag: "v1", exec, domainBase: "ddg.example.dev", probe: async (url) => { probed.push(url); return true; } }).ensure("waddle");
  assert.match(detail, /already running \(healthy\)/);
  assert.deepEqual(probed, ["https://waddle.ddg.example.dev"]);
  assert.ok(!calls.some((c) => c.includes("deploy")), "no deploy was attempted");
});

test("a Running machine with no derivable domain is trusted, never stopped", async () => {
  const { calls, exec } = fakeExec([{ args: ["container", "list"], stdout: LIST_NO_DOMAIN }]);
  const detail = await createPlatform({ backend: "tinfoil", deployTag: "v1", exec, probe: async () => true }).ensure("waddle");
  assert.match(detail, /no domain — probe skipped/);
  assert.ok(!calls.some((c) => c.includes("deploy") || c.includes("stop")), "no stop/deploy of a machine we can't probe");
});

test("ensure deploys (with the tag) when the machine is not Running", async () => {
  const { calls, exec } = fakeExec([
    { args: ["container", "list"], stdout: LIST_OUTPUT },
    { args: ["container", "deploy", "waddle-standby-1", "--tag", "v1"], stdout: "deployed" },
  ]);
  const detail = await tinfoil(exec).ensure("waddle-standby-1");
  assert.equal(detail, "deployed");
  assert.deepEqual(calls[1], ["container", "deploy", "waddle-standby-1", "--tag", "v1"]);
});

test("ensure falls through to deploy when the status call itself fails", async () => {
  const { exec } = fakeExec([
    { args: ["container", "list"], err: "CLI broke" },
    { args: ["container", "deploy", "waddle", "--tag", "v1"], stdout: "deployed" },
  ]);
  const detail = await tinfoil(exec).ensure("waddle");
  assert.equal(detail, "deployed");
});

test("start recovers a zombie: 409 → stop → retry deploy", async () => {
  let deploys = 0;
  const calls: string[][] = [];
  const exec: Exec = async (_c, args) => {
    calls.push([...args]);
    if (args[1] === "deploy") {
      deploys++;
      if (deploys === 1) throw new Error("cannot deploy a running instance");
      return { stdout: "recovered" };
    }
    return { stdout: "stopped" };
  };
  const detail = await tinfoil(exec).start("waddle");
  assert.match(detail, /zombie recovered/);
  assert.deepEqual(calls[1], ["container", "stop", "waddle"]); // stopped before retrying
});

test("start surfaces non-zombie deploy failures untouched", async () => {
  const exec: Exec = async () => {
    throw new Error("auth failed");
  };
  await assert.rejects(() => tinfoil(exec).start("waddle"), /auth failed/);
});

test("rest is idempotent: already-stopped errors are success", async () => {
  const exec: Exec = async () => {
    throw new Error('instance "waddle" is not running');
  };
  const detail = await tinfoil(exec).rest("waddle");
  assert.match(detail, /already stopped/);
});

test("docker backend: list parses `docker ps`, start/stop shell out", async () => {
  const { calls, exec } = fakeExec([
    { args: ["ps", "-a", "--format", "{{.Names}}"], stdout: "waddle\nconcierge\n" },
    { args: ["start", "waddle"], stdout: "" },
  ]);
  const p = createPlatform({ backend: "docker", exec });
  assert.deepEqual(await p.list(), ["waddle", "concierge"]);
  const detail = await p.ensure("waddle");
  assert.match(detail, /docker:waddle started/);
  assert.deepEqual(calls[1], ["start", "waddle"]);
});

test("waitRunning polls the platform API (no DNS) until Running", async () => {
  let lists = 0;
  const exec: Exec = async (_c, args) => {
    if (args[1] === "list") {
      lists++;
      return { stdout: lists < 3 ? LIST_OUTPUT.replace("Running", "Starting") : LIST_OUTPUT };
    }
    return { stdout: "ok" };
  };
  const p = tinfoil(exec);
  const t0 = Date.now();
  assert.equal(await p.waitRunning("waddle", 30_000), true);
  assert.ok(Date.now() - t0 >= 10_000, "waited across polls");
  assert.ok(lists >= 3);
});

test("waitRunning times out honestly (false — the machine still boots)", async () => {
  const exec: Exec = async (_c, args) =>
    args[1] === "list" ? { stdout: LIST_OUTPUT.replace("Running", "Starting") } : { stdout: "ok" };
  assert.equal(await tinfoil(exec).waitRunning("waddle", 1), false);
});
