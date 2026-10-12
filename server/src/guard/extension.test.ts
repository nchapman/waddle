/**
 * The guard extension: the factory's registration contract, the
 * tool_result redactor's pairing rules, and — the load-bearing one —
 * the guarded bash running real commands whose children never see the
 * gateway's secrets.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  SessionManager,
  SettingsManager,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ToolDefinition,
  type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { createGuardExtension, redactToolResult, handoffComponents, assertWorkspaceContained } from "./extension.js";
import { registerSecret, unregisterSecret } from "./policy.js";

const NAME = "guard-test-secret";
const VALUE = "guard-test-secret-value-123";

before(() => registerSecret(NAME, VALUE));
after(() => unregisterSecret(NAME));

/** Minimal capture of the extension API surface the factory uses. */
function fakePi() {
  const registeredTools: ToolDefinition[] = [];
  const handlers = new Map<string, Array<unknown>>();
  const api = {
    registerTool: (tool: ToolDefinition) => registeredTools.push(tool),
    on: (event: string, handler: unknown) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
    },
  } as unknown as ExtensionAPI;
  return { api, registeredTools, handlers };
}

test("factory: registers the guarded file tools and the tool_result redactor", () => {
  const { api, registeredTools, handlers } = fakePi();
  const factory = createGuardExtension("/tmp/workspace");
  assert.ok(typeof factory === "object" && "factory" in factory);
  (factory as { factory: (pi: ExtensionAPI) => void }).factory(api);

  const names = registeredTools.map((t) => t.name).sort();
  assert.deepEqual(names, ["edit", "write"], "same names ⇒ override the built-ins");
  assert.equal(handlers.get("tool_result")?.length, 1, "the redactor rides tool_result");
});

/** A synthetic tool_result event with just the fields the redactor reads. */
function resultEvent(content: ToolResultEvent["content"], structuredContent?: ToolResultEvent["structuredContent"]): ToolResultEvent {
  return { type: "tool_result", toolCallId: "t1", input: {}, content, structuredContent, isError: false } as unknown as ToolResultEvent;
}

test("redactor: clean results are a no-op", () => {
  const content = [{ type: "text", text: "all clear" }] as ToolResultEvent["content"];
  assert.equal(redactToolResult(resultEvent(content)), undefined);
});

test("redactor: scrubs content, drops nothing", () => {
  const out = redactToolResult(resultEvent([{ type: "text", text: `leaked ${VALUE}` }] as ToolResultEvent["content"]));
  assert.deepEqual(out?.content?.[0], { type: "text", text: `leaked [REDACTED:${NAME}]` });
  assert.equal("structuredContent" in (out ?? {}), false, "no structuredContent in ⇒ none out");
});

test("redactor: content and structuredContent redact together (pairing rule)", () => {
  const structured = { output: `twice ${VALUE}`, exit_code: 0 };
  const out = redactToolResult(
    resultEvent([{ type: "text", text: `once ${VALUE}` }] as ToolResultEvent["content"], structured),
  );
  assert.deepEqual(out?.content, [{ type: "text", text: `once [REDACTED:${NAME}]` }]);
  assert.deepEqual(out?.structuredContent, { output: `twice [REDACTED:${NAME}]`, exit_code: 0 });
});

test("redactor: structuredContent-only leak keeps the original content reference", () => {
  const content = [{ type: "text", text: "clean face" }] as ToolResultEvent["content"];
  const out = redactToolResult(resultEvent(content, { output: `hidden ${VALUE}` }));
  assert.equal(out?.content, content, "unchanged content passes by reference");
  assert.deepEqual(out?.structuredContent, { output: `hidden [REDACTED:${NAME}]` });
});

test("redactor: image content is untouchable and passes through", () => {
  const image = { type: "image", data: "abc", mimeType: "image/png" } as ToolResultEvent["content"][number];
  const out = redactToolResult(resultEvent([{ type: "text", text: `see ${VALUE}` }, image]));
  assert.equal(out?.content?.[1], image, "the image part keeps its reference");
});

test("handoff components stop at a symlink — chown must never follow a planted link", () => {
  const ws = mkdtempSync(join(tmpdir(), "waddle-handoff-"));
  try {
    mkdirSync(join(ws, "real"), { recursive: true });
    writeFileSync(join(ws, "real", "f.txt"), "x");
    symlinkSync("/etc/passwd", join(ws, "link")); // the planted link

    // A normal path hands over root + every component.
    assert.deepEqual(handoffComponents(join(ws, "real", "f.txt"), ws), [ws, join(ws, "real"), join(ws, "real", "f.txt")]);
    // Through the link: the walk stops BEFORE the link component —
    // chown(link) would follow it and hand /etc/passwd's dir to the agent.
    assert.deepEqual(handoffComponents(join(ws, "link", "evil.txt"), ws), [ws]);
    // The link itself as the target: same refusal.
    assert.deepEqual(handoffComponents(join(ws, "link"), ws), [ws]);
    // Outside the workspace: nothing at all.
    assert.deepEqual(handoffComponents("/etc/passwd", ws), []);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("handoff refuses a symlinked workspace root entirely", () => {
  const dir = mkdtempSync(join(tmpdir(), "waddle-handoff-root-"));
  try {
    const target = join(dir, "target");
    mkdirSync(target);
    const ws = join(dir, "ws");
    symlinkSync(target, ws); // a restored hostile workspace top
    assert.deepEqual(handoffComponents("anything.txt", ws), [], "no handoff through a symlinked root");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("workspace containment: realpath check catches symlink escapes, allows in-workspace links", () => {
  const dir = mkdtempSync(join(tmpdir(), "waddle-contain-"));
  const ws = join(dir, "workspace");
  try {
    mkdirSync(join(ws, "sub"), { recursive: true });
    writeFileSync(join(ws, "sub", "f.txt"), "x");
    mkdirSync(join(dir, "system"));
    writeFileSync(join(dir, "system", "secret"), "s");

    // Normal in-workspace paths pass (existing and to-be-created).
    assert.doesNotThrow(() => assertWorkspaceContained(join(ws, "sub", "f.txt"), ws));
    assert.doesNotThrow(() => assertWorkspaceContained(join(ws, "sub", "new.txt"), ws));
    // A fully missing chain (recursive mkdir shape): nearest existing
    // ancestor is the workspace itself.
    assert.doesNotThrow(() => assertWorkspaceContained(join(ws, "a", "b", "c.txt"), ws));

    // A link that stays inside the workspace is fine.
    symlinkSync("sub", join(ws, "inlink"));
    assert.doesNotThrow(() => assertWorkspaceContained(join(ws, "inlink", "f.txt"), ws));

    // A planted link that escapes: refused, for reads-of-target-shape and
    // writes-through alike.
    symlinkSync(join(dir, "system"), join(ws, "outlink"));
    assert.throws(() => assertWorkspaceContained(join(ws, "outlink", "secret"), ws), /outside the workspace/);
    assert.throws(() => assertWorkspaceContained(join(ws, "outlink", "planted.txt"), ws), /outside the workspace/);

    // A DANGLING escape link: realpath ENOENTs, lstat still sees it — the
    // write would CREATE the target as root (review-caught). Refused both
    // as the terminal component and under a not-yet-existing tail.
    symlinkSync("/etc/ld.so.preload", join(ws, "dangling"));
    assert.throws(() => assertWorkspaceContained(join(ws, "dangling"), ws), /outside the workspace/);
    assert.throws(() => assertWorkspaceContained(join(ws, "dangling", "x"), ws), /outside the workspace/);
    // A dangling link whose target stays INSIDE the workspace is fine.
    symlinkSync("not-yet-created", join(ws, "inner-dangling"));
    assert.doesNotThrow(() => assertWorkspaceContained(join(ws, "inner-dangling"), ws));

    // A symlinked workspace root: refused outright — containment would
    // otherwise be checked against the link's target (review-caught).
    const fakeRoot = join(dir, "faketarget");
    mkdirSync(fakeRoot);
    symlinkSync(fakeRoot, join(dir, "fakeWs"));
    assert.throws(() => assertWorkspaceContained("x.txt", join(dir, "fakeWs")), /workspace root itself is a symlink/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("integration: the guard extension loads in a real session and keeps bash active", async () => {
  const dir = mkdtempSync(join(tmpdir(), "waddle-guard-session-"));
  mkdirSync(join(dir, "workspace"), { recursive: true });
  // Outer try/finally: a pi API drift that breaks reload()/createAgentSession
  // must still clean up the scratch dir (review-caught leak).
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | null = null;
  try {
    const workspace = join(dir, "workspace");
    const loader = new DefaultResourceLoader({
      cwd: workspace,
      agentDir: join(dir, "pi-agent"),
      settingsManager: SettingsManager.inMemory({}, { projectTrusted: false }),
      extensionFactories: [createGuardExtension(workspace)],
    });
    await loader.reload();
    ({ session } = await createAgentSession({
      cwd: workspace,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(),
      tools: ["read", "bash"],
    }));
    assert.ok(session.getActiveToolNames().includes("bash"), "the overridden bash is the active one");
    assert.match(session.systemPrompt, /Execute bash commands/, "pi's bash snippet reaches the prompt");
    assert.doesNotMatch(session.systemPrompt, new RegExp(VALUE));
  } finally {
    session?.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
