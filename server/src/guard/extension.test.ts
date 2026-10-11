/**
 * The guard extension: the factory's registration contract, the
 * tool_result redactor's pairing rules, and — the load-bearing one —
 * the guarded bash running real commands whose children never see the
 * gateway's secrets.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
import { createGuardExtension, buildGuardedBashTool, redactToolResult } from "./extension.js";
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

test("factory: registers the guarded bash and the tool_result redactor", () => {
  const { api, registeredTools, handlers } = fakePi();
  const factory = createGuardExtension("/tmp/workspace");
  assert.ok(typeof factory === "object" && "factory" in factory);
  (factory as { factory: (pi: ExtensionAPI) => void }).factory(api);

  const bash = registeredTools.find((t) => t.name === "bash");
  assert.ok(bash, "bash must be registered (same name ⇒ overrides the built-in)");
  assert.equal(registeredTools.length, 1, "the guard registers exactly one tool");
  assert.equal(bash.promptSnippet, "Execute bash commands (ls, grep, find, etc.)", "pi's bash craft survives the override");
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

test("guarded bash: children never see the gateway's secrets", async () => {
  const ws = mkdtempSync(join(tmpdir(), "waddle-bash-"));
  const tool = buildGuardedBashTool(ws);
  const saved = { CONCIERGE_SHARED_SECRET: process.env.CONCIERGE_SHARED_SECRET, TINFOIL_API_KEY: process.env.TINFOIL_API_KEY };
  process.env.CONCIERGE_SHARED_SECRET = "env-secret-concierge-xyz";
  process.env.TINFOIL_API_KEY = "env-secret-inference-xyz";
  try {
    const res = await tool.execute("t1", { command: "printenv" }, undefined, undefined, undefined as never);
    const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    assert.ok(!text.includes("env-secret-concierge-xyz"), "the concierge secret must not reach a child");
    assert.ok(!text.includes("env-secret-inference-xyz"), "the inference key must not reach a child");
    assert.match(text, /PATH=/, "the allowlist still passes what shells need");
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k as keyof typeof saved];
      else process.env[k as keyof typeof saved] = v;
    }
    rmSync(ws, { recursive: true, force: true });
  }
});

test("layering: bash output is raw at the tool, redacted at the transcript boundary", async () => {
  const ws = mkdtempSync(join(tmpdir(), "waddle-bash-"));
  try {
    const tool = buildGuardedBashTool(ws);
    const res = await tool.execute("t1", { command: `echo says ${VALUE}` }, undefined, undefined, undefined as never);
    const raw = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    assert.ok(raw.includes(VALUE), "the tool itself returns raw output");

    const out = redactToolResult(resultEvent(res.content as ToolResultEvent["content"]));
    const scrubbed = out?.content?.map((c) => (c.type === "text" ? c.text : "")).join("") ?? "";
    assert.ok(!scrubbed.includes(VALUE), "the redactor scrubs it before the transcript");
    assert.ok(scrubbed.includes(`[REDACTED:${NAME}]`));
  } finally {
    rmSync(ws, { recursive: true, force: true });
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
