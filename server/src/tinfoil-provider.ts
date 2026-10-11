/**
 * Inline extension: the tinfoil inference provider, hand-registered.
 *
 * Why not @tinfoilsh/pi-provider as a file extension? jiti-loading the npm
 * package inside the container failed silently (models never registered);
 * an inline factory is plain ESM in our own module graph — load failures
 * become our boot failures, visible in the black box.
 *
 * Same trust mechanics as the upstream extension: SecureClient verifies the
 * inference enclave and every request body rides the HPKE-encrypted channel
 * (TEE-to-TEE). We fail loud on verification (boot dies with the real error)
 * rather than failing closed per-request — waddle has no interactive /retry.
 */
import { SecureClient } from "tinfoil";
import { openAICompletionsApi, lazyStream } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Static catalog (verified live ids): reasoning stays false — Tinfoil's
// endpoint rejects the "developer" role pi-ai sends for reasoning models.
const MODELS: {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}[] = [
  {
    id: "deepseek-v4-1-flash",
    name: "DeepSeek V4.1 Flash",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262144,
    maxTokens: 16384,
  },
  {
    id: "kimi-k3",
    name: "Kimi K3",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262144,
    maxTokens: 16384,
  },
];

/** Set if the factory failed — pi's runner swallows extension errors, so
 *  boot() reads this to fail loud with the real cause. */
export let factoryError: string | null = null;

export default async function tinfoilProvider(pi: ExtensionAPI): Promise<void> {
  try {
    const secureClient = new SecureClient();
    await secureClient.ready(); // loud: boot dies with the verification error
    const resolved = secureClient.getBaseURL();
    if (!resolved) throw new Error("SecureClient: no base URL after verification");
    const baseUrl = resolved.replace(/\/+$/, "");

    const base = openAICompletionsApi();
    const simple = base.streamSimple;
    if (!simple) throw new Error("openAICompletionsApi: no streamSimple");
    pi.registerProvider("tinfoil", {
      baseUrl,
      apiKey: "$TINFOIL_API_KEY",
      api: "openai-completions",
      models: [...MODELS],
      streamSimple: (model, context, options) =>
        lazyStream(model, async () =>
          simple(model, context, { ...options, fetch: secureClient.fetch }),
        ),
    });
  } catch (e) {
    factoryError = e instanceof Error ? `${e.message}\n${e.stack ?? ""}`.slice(0, 800) : String(e);
  }
}
