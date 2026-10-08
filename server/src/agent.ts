/**
 * The agent: pi embedded, Tinfoil inference from inside the enclave.
 * The @tinfoilsh/pi-provider extension verifies the inference TEE and
 * HPKE-encrypts every request (TEE-to-TEE); the API key arrives from
 * the client at unlock — memory-only, never on disk.
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import tinfoilProvider, { factoryError } from "./tinfoil-provider.js";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const require = createRequire(import.meta.url);
const PROVIDER_ENTRY = require.resolve("@tinfoilsh/pi-provider/tinfoil.ts");

const DATA_DIR = process.env.DATA_DIR ?? "/tmp/waddle-data";
const lockDataDir = () => DATA_DIR;

const SYSTEM_PROMPT = [
  "You are waddle — the user's personal agent, running privately in a secure enclave.",
  "First Light: conversation only (no tools yet). Be concise, warm, and direct.",
  "You are a penguin-shaped agent; a light touch of personality is welcome.",
].join("\n");

let ready: Promise<{
  prompt: (text: string, onDelta: (delta: string) => void) => Promise<string>;
}> | null = null;

/** Black box: boot/crash evidence lands in the encrypted log, readable after
 *  restart+unlock — the only channel out of a dying process. */
export let blackbox: ((message: string) => void) | null = null;
export function setBlackbox(fn: (message: string) => void): void {
  blackbox = fn;
}

/** Idempotent per-boot init. The key must be set before the extension loads. */
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
  const modelRuntime = await ModelRuntime.create({
    // /root is on the read-only rootfs — every pi path must live on scratch.
    authPath: join(lockDataDir(), "pi-agent", "auth.json"),
    modelsPath: join(lockDataDir(), "pi-agent", "models.json"),
  });
  const agentDir = join(lockDataDir(), "pi-agent");
  mkdirSync(agentDir, { recursive: true });
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir,
    systemPromptOverride: () => SYSTEM_PROMPT,
    appendSystemPromptOverride: () => [],
    extensionFactories: [{ name: "waddle-tinfoil", factory: tinfoilProvider }],
  });
  await loader.reload();

  const { session } = await createAgentSession({
    modelRuntime,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(),
    noTools: "all",
  });

  if (factoryError) throw new Error(`tinfoil provider factory failed (pi swallows these): ${factoryError}`);
  // The inline factory registers during session creation; the catalog
  // bakes in reasoning:false (Tinfoil rejects the "developer" role).
  const tinfoilModel = modelRuntime.getModel("tinfoil", process.env.WADDLE_MODEL ?? "deepseek-v4-1-flash");
  if (!tinfoilModel) throw new Error("tinfoil model not found — inline provider failed to register");
  await session.setModel(tinfoilModel);

  return {
    async prompt(text: string, onDelta: (delta: string) => void): Promise<string> {
      let final = "";
      const unsubscribe = session.subscribe((event) => {
        if (
          event.type === "message_update" &&
          event.assistantMessageEvent.type === "text_delta"
        ) {
          final += event.assistantMessageEvent.delta;
          onDelta(event.assistantMessageEvent.delta);
        }
      });
      try {
        await session.prompt(text);
      } finally {
        unsubscribe();
      }
      return final;
    },
  };
}

export async function chat(text: string, onDelta: (delta: string) => void): Promise<string> {
  if (!ready) throw new Error("agent not initialized — unlock with an inference key first");
  const agent = await ready;
  return agent.prompt(text, onDelta);
}
