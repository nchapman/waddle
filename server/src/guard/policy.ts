/**
 * The playpen: what the agent's child processes may see, and which values
 * must never appear in one. This module is pure policy data + filters —
 * enforcement happens where children spawn (guard/extension.ts, browser.ts)
 * and in the redactor (guard/redact.ts).
 *
 * Philosophy (see PLAN.md "Agent guardrails"): hard land, wild playpen.
 * The agent is permissive inside its roots; the land — secrets in the
 * parent env, system state — is locked by construction, not by asking.
 */

/**
 * Env keys a child process may inherit. Everything else is dropped —
 * in particular CONCIERGE_SHARED_SECRET and TINFOIL_API_KEY, which live
 * only in the gateway's env. PI_* is pi's session metadata (id, model),
 * not a secret; the bash tool's guidelines tell the agent about them.
 */
const ENV_ALLOW: RegExp = /^(?:PATH|HOME|TMPDIR|TZ|LANG|LC_[A-Z0-9_]+|TERM|SHELL|XDG_[A-Z0-9_]+|PI_[A-Z0-9_]+)$/;

/** Filter an environment down to the allowlist. Children spawn with this. */
export function scrubEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && ENV_ALLOW.test(key)) out[key] = value;
  }
  return out;
}

/**
 * Values that must never reach the transcript. Registered by the gateway
 * as secrets arrive (boot env, unlock, arm); scrubbed from every tool
 * result by the guard extension's tool_result handler and from child
 * output as belt-and-braces. The registry holds references the gateway
 * already keeps — registration adds no new exposure.
 */
const secrets = new Map<string, string>();

/** Shorter values would scrub unrelated text (noise), not protect anything. */
export const SECRET_FLOOR = 8;

export function registerSecret(name: string, value: string | null | undefined): void {
  if (!value || value.length < SECRET_FLOOR) return;
  secrets.set(name, value);
}

export function unregisterSecret(name: string): void {
  secrets.delete(name);
}

/** Snapshot for redaction; the map itself is never handed out. */
export function registeredSecrets(): ReadonlyArray<[name: string, value: string]> {
  return [...secrets.entries()];
}

/** The platform secrets present at boot. Call once from the entrypoint. */
export function registerBootSecrets(env: NodeJS.ProcessEnv = process.env): void {
  registerSecret("concierge-shared-secret", env.CONCIERGE_SHARED_SECRET);
  registerSecret("inference-key", env.TINFOIL_API_KEY);
}

/**
 * DATA_DIR entries that are the system's, not the agent's: the sealed
 * log, the TOFU verifier, transcripts, schedules, pi's runtime config,
 * the browser profile (cookies = bearer tokens), and the dev-only wake
 * credential. The agent's roots are workspace/, tmp/, home/ — everything
 * else is off-limits. The tripwire (guard/tripwire.ts) pattern-matches
 * against these; slice 2's uid separation makes them actually invisible.
 */
export const DATA_DIR = process.env.DATA_DIR ?? "/tmp/waddle-data";

export const SYSTEM_PATHS = [
  "log",
  "verifier.bin",
  "sessions",
  "schedules.json",
  "preferences.json",
  "pi-agent",
  "browser",
  "wake-credential.json",
] as const;

/** Absolute forms of the system paths, for pattern matching. */
export function systemAbsPaths(): string[] {
  return SYSTEM_PATHS.map((p) => `${DATA_DIR}/${p}`);
}

/** The guard's posture. Autonomous (scheduled) runs block what gray-area
 *  interactive runs would ask about — nobody is attached to answer. */
export type GuardMode = "interactive" | "autonomous";
