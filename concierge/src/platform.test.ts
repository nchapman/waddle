import { test } from "node:test";
import assert from "node:assert/strict";
import { createPlatform, type Exec } from "./platform.js";

const LIST_OUTPUT = [
  "NAME                 STATUS",
  "waddle               Running",
  "waddle-standby-1     Stopped",
  "other-account-thing  Running",
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

const tinfoil = (exec: Exec, deployTag = "v1") => createPlatform({ backend: "tinfoil", deployTag, exec });

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

test("ensure short-circuits on Running — no deploy on a healthy machine", async () => {
  const { calls, exec } = fakeExec([{ args: ["container", "list"], stdout: LIST_OUTPUT }]);
  const detail = await tinfoil(exec).ensure("waddle");
  assert.match(detail, /already running/);
  assert.ok(!calls.some((c) => c.includes("deploy")), "no deploy was attempted");
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
