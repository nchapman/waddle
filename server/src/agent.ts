/**
 * The agent: pi embedded, Tinfoil inference from inside the enclave.
 * The inline tinfoil provider verifies the inference TEE and HPKE-encrypts
 * every request (TEE-to-TEE); the API key arrives from the client at
 * unlock — memory-only, never on disk.
 *
 * The Hands: pi's built-in tool loop (read/bash/edit/write) runs against
 * an encrypted workspace on scratch; tool events stream out live; sessions
 * are file-backed so context survives reconnects.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import tinfoilProvider, { factoryError } from "./tinfoil-provider.js";
import { needsApproval, requestApproval, setApprovalEmitter } from "./approvals.js";

const DATA_DIR = process.env.DATA_DIR ?? "/tmp/waddle-data";
const WORKSPACE = join(DATA_DIR, "workspace");
const SESSIONS = join(DATA_DIR, "sessions");

const SYSTEM_PROMPT = [
  "You are waddle — the user's personal agent, running privately in a secure enclave.",
  "You have real tools: read, bash, edit, write. Your working directory is a private",
  "workspace; treat it as the user's own files. Be concise, warm, and direct.",
  "You are a penguin-shaped agent; a light touch of personality is welcome.",
].join("\n");

/** Live agent activity for the wire: text deltas + tool execution. */
export interface AgentEvents {
  onDelta: (delta: string) => void;
  onToolStart?: (callId: string, tool: string, args: unknown) => void;
  onToolEnd?: (callId: string, tool: string, result: unknown, isError: boolean) => void;
}

let ready: Promise<{ setSink: (s: object) => void; chat: (t: string) => Promise<void>; isStreaming: () => boolean }> | null = null;

/** Black box: boot/crash evidence lands in the encrypted log, readable after
 *  restart+unlock — the only channel out of a dying process. */
export let blackbox: ((message: string) => void) | null = null;
export function setBlackbox(fn: (message: string) => void): void {
  blackbox = fn;
}

/** Idempotent per-boot init. The key must be set before the provider verifies. */
export function initAgent(apiKey: string): void {
  process.env.TINFOIL_API_KEY = apiKey;
  if (ready) return;
  ready = boot();
  ready.catch((e) => blackbox?.(`agent boot failed: ${e instanceof Error ? `${e.message}` : String(e)}`));
}

export function agentReady(): boolean {
  return ready !== null;
}

async function boot() {
  mkdirSync(WORKSPACE, { recursive: true });
  mkdirSync(SESSIONS, { recursive: true });

  const modelRuntime = await ModelRuntime.create({
    // /root is on the read-only rootfs — every pi path must live on scratch.
    authPath: join(DATA_DIR, "pi-agent", "auth.json"),
    modelsPath: join(DATA_DIR, "pi-agent", "models.json"),
  });
  const agentDir = join(DATA_DIR, "pi-agent");
  mkdirSync(agentDir, { recursive: true });
  // The ask-gate extension: pi fires tool_call before execution; our async
  // handler holds the call until the browser (or the timeout) decides.
  // Deny => { block: true } => the tool does not run.
  const approvalGate = {
    name: "waddle-approvals",
    factory: (pi: { on: (event: "tool_call", handler: (e: { toolCallId: string; toolName: string; input: Record<string, unknown> }) => Promise<{ block?: boolean; reason?: string }>) => void }) => {
      pi.on("tool_call", async (event) => {
        if (!needsApproval(event.toolName, event.input)) return {};
        const approved = await requestApproval(event.toolCallId, event.toolName, event.input);
        return approved ? {} : { block: true, reason: "the user denied this tool call in the browser" };
      });
    },
  };

  const loader = new DefaultResourceLoader({
    cwd: WORKSPACE,
    agentDir,
    systemPromptOverride: () => SYSTEM_PROMPT,
    appendSystemPromptOverride: () => [],
    extensionFactories: [approvalGate, { name: "waddle-tinfoil", factory: tinfoilProvider }],
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: WORKSPACE,
    modelRuntime,
    resourceLoader: loader,
    // File-backed on scratch: context survives reconnects (and snapshots).
    sessionManager: SessionManager.create(WORKSPACE, SESSIONS),
    tools: ["read", "bash", "edit", "write"],
  });

  if (factoryError) throw new Error(`tinfoil provider factory failed (pi swallows these): ${factoryError}`);
  // The inline factory registers during session creation; the catalog
  // bakes in reasoning:false (Tinfoil rejects the "developer" role).
  const tinfoilModel = modelRuntime.getModel("tinfoil", process.env.WADDLE_MODEL ?? "deepseek-v4-1-flash");
  if (!tinfoilModel) throw new Error("tinfoil model not found — inline provider failed to register");
  await session.setModel(tinfoilModel);

  // One persistent subscriber: everything flows through the sink, so queued
  // and steered runs stream exactly like the first turn.
  const sink: { onDelta?: (d: string) => void; onToolStart?: (c: string, t: string, a: unknown) => void; onToolEnd?: (c: string, t: string, r: unknown, e: boolean) => void; onAssistantFinal?: (t: string) => void; onApprovalRequest?: (req: { type: "approval_request"; callId: string; tool: string; input: unknown; at?: string }) => void; onSettled?: () => void } = {};
  const textOf = (content: unknown): string => {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((part) =>
          typeof part === "string" ? part : part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : "",
        )
        .join("");
    }
    return "";
  };
  setApprovalEmitter((event) => {
    if (event.type === "approval_request") sink.onApprovalRequest?.(event);
  });
  session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      sink.onDelta?.(event.assistantMessageEvent.delta);
    } else if (event.type === "tool_execution_start") {
      sink.onToolStart?.(event.toolCallId, event.toolName, event.args);
    } else if (event.type === "tool_execution_end") {
      sink.onToolEnd?.(event.toolCallId, event.toolName, event.result, event.isError === true);
    } else if (event.type === "agent_settled") {
      sink.onSettled?.();
    } else if (event.type === "message_end" && event.message?.role === "assistant") {
      const text = textOf((event.message as { content?: unknown }).content);
      if (text) sink.onAssistantFinal?.(text);
    }
  });

  return {
    setSink(next: typeof sink): void {
      Object.keys(sink).forEach((k) => delete sink[k as keyof typeof sink]);
      Object.assign(sink, next);
    },
    async chat(text: string): Promise<void> {
      if (agentBusy) {
        // Mid-turn: steer the active run (pi applies it after the current
        // tool batch). Queued follow-ups land via the same event stream.
        await session.steer(text);
        return;
      }
      agentBusy = true;
      streaming = true;
      try {
        await session.prompt(text);
      } finally {
        streaming = false;
        agentBusy = false;
      }
    },
    isStreaming: () => streaming,
  };
}

let agentBusy = false;
let streaming = false;

/** Wire the live event sink (the active WSS connection). */
export async function setSink(
  sink: {
    onDelta?: (delta: string) => void;
    onToolStart?: (callId: string, tool: string, args: unknown) => void;
    onToolEnd?: (callId: string, tool: string, result: unknown, isError: boolean) => void;
    onAssistantFinal?: (text: string) => void;
    onApprovalRequest?: (req: { type: "approval_request"; callId: string; tool: string; input: unknown; at?: string }) => void;
    onSettled?: () => void;
  },
): Promise<void> {
  if (!ready) throw new Error("agent not initialized");
  (await ready).setSink(sink);
}

/** Send a user turn: prompts when idle, steers when mid-run. */
export async function chat(text: string): Promise<void> {
  if (!ready) throw new Error("agent not initialized — unlock with an inference key first");
  await (await ready).chat(text);
}
