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
import { resolve } from "node:path";

/**
 * Env keys a child process may inherit. Everything else is dropped —
 * in particular CONCIERGE_SHARED_SECRET and TINFOIL_API_KEY, which live
 * only in the gateway's env. PI_* is pi's session metadata (id, model),
 * not a secret.
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

/** Root-owned system entries: the sealed log, the TOFU verifier,
 *  transcripts, schedules, preferences, pi's runtime config, and the
 *  dev-only wake credential. Root-owned 0600/0700 (guard/playpen.ts). */
export const SYSTEM_PATHS = [
  "log",
  "verifier.bin",
  "sessions",
  "schedules.json",
  "preferences.json",
  "pi-agent",
  "wake-credential.json",
] as const;

/** The browser's own trees — the profile (cookies = bearer tokens) and
 *  its HOME. Also not the agent's, but owned by the browser uid, not
 *  root: the shell cannot read them, Chromium can write them. */
export const BROWSER_PATHS = ["browser", "home"] as const;

/** Every DATA_DIR entry that is not the agent's — the tripwire's
 *  matching set. The agent's roots are workspace/ and the shared tmp/. */
export const NON_AGENT_PATHS: readonly string[] = [...SYSTEM_PATHS, ...BROWSER_PATHS];

/** Absolute forms of the system paths (root-owned), for enforcement. */
export function systemAbsPaths(): string[] {
  return SYSTEM_PATHS.map((p) => `${DATA_DIR}/${p}`);
}

/** Absolute forms of every non-agent path, for tripwire matching. */
export function nonAgentAbsPaths(): string[] {
  return NON_AGENT_PATHS.map((p) => `${DATA_DIR}/${p}`);
}

/** The agent's writable root (file-tool base, workspace-relative paths). */
export const WORKSPACE = `${DATA_DIR}/workspace`;

/** Resolve like the file tools do (relative paths are workspace-relative)
 *  and test containment — traversal collapses, so ../ escapes fall out. */
export function isWorkspacePath(path: string): boolean {
  if (path === "" || path === "/") return false;
  const full = resolve(WORKSPACE, path);
  return full === WORKSPACE || full.startsWith(`${WORKSPACE}/`);
}

// ── The playpen's uids (slice 2: kernel separation) ────────────────────
// The gateway stays root: it owns the system tree (umask 077 makes every
// file it creates root-only) and re-owns restored trees. Children are
// unprivileged: Chromium runs as the browser uid — so it cannot read the
// log, verifier, sessions, schedules, or pi's config. The agent itself
// has no process at all (codemode's sandbox is in-VM), but the workspace
// stays owned by uid 1100 so the kernel wall still bounds any future
// uid-1100 execution seam (and the "memory-only" master secret stays
// unreachable to any child).

/** Numeric ids; overridable via env for compose/dev experiments. */
export const AGENT_UID = Number(process.env.WADDLE_AGENT_UID ?? 1100);
export const BROWSER_UID = Number(process.env.WADDLE_BROWSER_UID ?? 1101);

/** The playpen needs root to chown/setuid children. On a dev host
 *  (unprivileged) it degrades honestly: scrubbing and redaction stay,
 *  the kernel boundary does not — /health says so. */
export function playpenActive(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

/** The guard's posture. Autonomous (scheduled) runs block what gray-area
 *  interactive runs would ask about — nobody is attached to answer. */
export type GuardMode = "interactive" | "autonomous";
