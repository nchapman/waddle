/**
 * The agent's tool loadout, integration-level: codemode active, NO bash,
 * the file tools present and actually guarded. This pins the no-shell
 * contract at the seam where it lives — the real session construction —
 * not just the pieces.
 *
 * Run: node --import tsx --test src/agent-tools.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const scratch = mkdtempSync(join(tmpdir(), "waddle-agent-tools-"));
process.env.DATA_DIR = scratch;
const WORKSPACE = join(scratch, "workspace");
const SESSIONS = join(scratch, "sessions");
mkdirSync(WORKSPACE, { recursive: true });
mkdirSync(SESSIONS, { recursive: true });

const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, createCodemodeExtension } = await import(
  "@earendil-works/pi-coding-agent"
);
const { createGuardExtension } = await import("./guard/extension.js");
const { buildCustomTools } = await import("./agent.js");

test("the session exposes codemode, never bash, and guarded file tools", async () => {
  const agentDir = join(scratch, "pi-agent");
  mkdirSync(agentDir, { recursive: true });
  const loader = new DefaultResourceLoader({
    cwd: WORKSPACE,
    agentDir,
    extensionFactories: [createGuardExtension(WORKSPACE), createCodemodeExtension()],
  });
  await loader.reload();

  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
  const sessionManager = SessionManager.create(WORKSPACE, SESSIONS);
  const { session } = await createAgentSession({
    cwd: WORKSPACE,
    modelRuntime,
    resourceLoader: loader,
    sessionManager,
    customTools: buildCustomTools(),
    tools: [
      "read", "edit", "write", "grep", "find", "ls", "codemode",
      "browser_open", "browser_snapshot", "browser_click", "browser_type", "browser_press_key", "browser_wait_for", "browser_select", "browser_scroll",
      "schedule_create", "schedule_list", "schedule_cancel",
    ],
  });

  const active = session.getActiveToolNames();
  assert.ok(active.includes("codemode"), `codemode must be active: ${active.join(",")}`);
  assert.ok(!active.includes("bash"), "there is no shell — bash must not be active");
  assert.equal(session.getToolDefinition("bash"), undefined, "bash is not even registered");
  assert.equal(session.getToolDefinition("powershell"), undefined, "no powershell either");
  // The smoothed browser surface is present in full: waits, keys, dropdowns.
  for (const t of ["browser_wait_for", "browser_press_key", "browser_select", "browser_scroll"]) {
    assert.ok(active.includes(t), `${t} must be active`);
  }
  // Scripts cannot start other scripts, so codemode is never in the CALLABLE
  // set — but the file tools are, for composition from inside scripts.
  const callable = session.getCallableToolNames();
  for (const t of ["read", "write", "edit", "grep", "find", "ls"]) {
    assert.ok(callable.includes(t), `${t} must be callable (codemode composes it)`);
    assert.ok(active.includes(t), `${t} must be active`);
  }
  assert.ok(!callable.includes("bash"), "no shell reachable from scripts either");

  // The REGISTERED write tool is the guard's (containment live), not pi's:
  // a write inside the workspace lands agent-rooted, an escape refuses.
  const write = session.getToolDefinition("write");
  assert.ok(write, "write is registered");
  const target = join(WORKSPACE, "hello.txt");
  await write.execute("t-write", { path: target, content: "quack" }, undefined, undefined, undefined as never);
  assert.equal(readFileSync(target, "utf-8"), "quack");
  // A planted escape link through the registered tool: refused.
  const { symlinkSync, existsSync } = await import("node:fs");
  symlinkSync(join(scratch, "log"), join(WORKSPACE, "escape"));
  mkdirSync(join(scratch, "log"), { recursive: true });
  await assert.rejects(
    () => write.execute("t-escape", { path: join(WORKSPACE, "escape", "evil.txt"), content: "x" }, undefined, undefined, undefined as never),
    /outside the workspace/,
    "the session's write tool must refuse symlink escapes",
  );
  assert.ok(!existsSync(join(scratch, "log", "evil.txt")), "nothing landed in the system tree");

  // Codemode actually executes: a pure-computation script (no tool calls —
  // those need the session's tool pipeline, which only a model-driven turn
  // provides; pi's own tests cover nested-call gating, and the callable set
  // above pins what scripts can reach). Proves QuickJS loads and runs in
  // this embedded setup — the load-bearing dependency.
  const codemode = session.getToolDefinition("codemode");
  assert.ok(codemode, "codemode is registered");
  const scriptResult = await codemode.execute(
    "t-code",
    { code: `return "script says: " + (2 + 2);` },
    undefined,
    undefined,
    undefined as never,
  );
  const scriptText = scriptResult.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  assert.match(scriptText, /script says: 4/, `QuickJS executes in-process: ${scriptText.slice(0, 200)}`);

  session.abort?.();
});

after(() => rmSync(scratch, { recursive: true, force: true }));
