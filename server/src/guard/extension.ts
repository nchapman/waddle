/**
 * The waddle guard extension — pi-core behavior changes ride the extension
 * seam, never ad-hoc tool surgery:
 *
 *   1. `bash` is re-registered from pi's own factory with guarded
 *      operations (env scrubbing now; the operations seam is where uid
 *      separation lands in slice 2). Same name ⇒ overrides the built-in
 *      for the session; same schema, snippet, truncation, and timeout
 *      semantics — only the child env changes.
 *   2. A `tool_result` handler redacts registered secrets from every
 *      tool's output at the transcript boundary (content and
 *      structuredContent together — replacing one drops the other).
 *
 * Known limit, accepted for now: bash's truncated-output temp files hold
 * unredacted bytes on the ephemeral ramdisk; reading one back goes through
 * `read`, whose result is redacted on the way in. Slice 2's uid
 * separation makes the whole question moot for the system tree.
 */
import {
  createBashToolDefinition,
  createLocalBashOperations,
  type BashOperations,
  type ExtensionAPI,
  type InlineExtension,
  type ToolDefinition,
  type ToolResultEvent,
  type ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import { scrubEnv } from "./policy.js";
import { containsSecret, scrubJson, scrubSecrets } from "./redact.js";

/** pi's local execution with the child env filtered to the allowlist. */
function guardedOperations(): BashOperations {
  const local = createLocalBashOperations();
  return {
    exec: (command, cwd, options) =>
      local.exec(command, cwd, { ...options, env: scrubEnv(options.env ?? process.env) }),
  };
}

/** pi's bash tool, guarded — export for direct tests. The erased
 *  annotation keeps the concrete generics (pi's render-state types are
 *  not re-exported portably); registerTool() accepts it as-is. */
export function buildGuardedBashTool(workspace: string): ToolDefinition<any, any, any> {
  return createBashToolDefinition(workspace, { operations: guardedOperations() });
}

/**
 * Redact secrets from a finished tool result. Returns undefined when
 * nothing matched (a clean no-op for the handler chain).
 */
export function redactToolResult(event: ToolResultEvent): ToolResultEventResult | undefined {
  let contentChanged = false;
  const content = event.content.map((part) => {
    if (part.type === "text" && containsSecret(part.text)) {
      contentChanged = true;
      return { ...part, text: scrubSecrets(part.text) };
    }
    return part;
  });

  const structured = event.structuredContent;
  let structuredChanged = false;
  let structuredOut = structured;
  if (structured !== undefined) {
    const next = scrubJson(structured);
    if (next !== structured) {
      structuredChanged = true;
      structuredOut = next;
    }
  }

  if (!contentChanged && !structuredChanged) return undefined;
  return {
    content: contentChanged ? content : event.content,
    // Pairing rule: replacing content drops structuredContent unless it is
    // returned too — scrubbed if it changed, the original if it did not.
    ...(structuredOut !== undefined ? { structuredContent: structuredOut } : {}),
  };
}

/** The guard extension: guarded bash + transcript-boundary redaction. */
export function createGuardExtension(workspace: string): InlineExtension {
  return {
    name: "waddle-guard",
    factory: (pi: ExtensionAPI) => {
      pi.registerTool(buildGuardedBashTool(workspace));
      pi.on("tool_result", redactToolResult);
    },
  };
}
