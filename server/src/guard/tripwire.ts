/**
 * The tripwires: pattern checks at critical moments that catch EGREGIOUS
 * calls — system-tree access, the concierge, the browser's CDP endpoint.
 * This is the catch-and-signal layer, not the enforcement layer: a
 * determined agent can obfuscate past any pattern, and that is fine by
 * design (the kernel boundary is slice 2; the point is that accidents and
 * injected nonsense fail loudly with a clear reason instead of
 * mysteriously).
 *
 * There is no shell to analyze (bash is gone; codemode's sandbox replaced
 * it), so every check runs on TYPED parameters — file paths and URLs —
 * not command text. That is the quiet win of the no-shell shape: the
 * checks are exact instead of best-effort regex over a command string.
 */
import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { DATA_DIR, NON_AGENT_PATHS } from "./policy.js";

export type TripwireVerdict =
  | { verdict: "allow" }
  | { verdict: "block"; reason: string };

const CONCIERGE_ORIGIN = process.env.CONCIERGE_URL ?? "";

/** DATA_DIR resolved through any symlinked ancestors (macOS tmpdirs:
 *  /var → /private/var) — a canonical path must be compared against a
 *  canonical base, or every realpath check silently passes. */
let realDataCache: string | null = null;
function realData(): string {
  if (realDataCache === null) {
    try {
      realDataCache = realpathSync(DATA_DIR);
    } catch {
      realDataCache = DATA_DIR; // not created yet: the lexical form is all we have
    }
  }
  return realDataCache;
}

function isUnderNonAgent(base: string, full: string): boolean {
  if (full === base || full.startsWith(`${base}/`)) {
    const rest = full === base ? "" : full.slice(base.length + 1);
    const first = rest.split("/")[0] ?? "";
    return rest === "" || NON_AGENT_PATHS.includes(first);
  }
  return false;
}

/** Does this RESOLVED absolute path sit in the system or browser trees?
 *  Both the lexical and the canonical base are checked: inputs arrive in
 *  the lexical form, realpathSync output in the canonical one. */
function isNonAgentAbsPath(full: string): boolean {
  return isUnderNonAgent(DATA_DIR, full) || isUnderNonAgent(realData(), full);
}

/** Is this path (a file-tool target) inside the system or browser trees?
 *  Relative paths are workspace-relative, as in the file tools. The
 *  platform's resolve() does the traversal math — hand-rolled
 *  normalization is how `a/../../log` evades (review-caught). */
function isNonAgentPath(path: string): boolean {
  return isNonAgentAbsPath(resolve(DATA_DIR, "workspace", path));
}

/** The READ half follows symlinks (review-caught): a restored hostile
 *  archive can plant `workspace/link -> /data/log`, and the read tools run
 *  in-process as root — the kernel cannot gate them. Writes get the same
 *  treatment at the operations layer; for reads this gate IS the guard, so
 *  resolve what the path really points at before allowing it. A missing
 *  path falls back to the lexical verdict (the tool's own ENOENT will
 *  answer the rest). */
function readResolvesIntoNonAgentPath(path: string): boolean {
  const full = resolve(DATA_DIR, "workspace", path);
  try {
    return isNonAgentAbsPath(realpathSync(full));
  } catch {
    return isNonAgentAbsPath(full);
  }
}

function systemTreeReason(): string {
  return `refused: that path is waddle system state, not workspace — the log, verifier, transcripts, schedules, profile, and browser home are the system's (${DATA_DIR}/{${NON_AGENT_PATHS.join(",")}})`;
}

/**
 * The dispatch check. Unknown tools allow — the playpen defaults open;
 * new egregious patterns are added as they are seen in the wild.
 *
 * Writes get realpath containment in the tool operations (guard/extension)
 * — this layer gives them the clear reason. Reads of the system tree are
 * blocked here because the read tools execute in-process as root: the
 * kernel boundary cannot gate them, and the sealed log / schedules /
 * wake credential are not the agent's to read even as harmless-looking
 * ciphertext.
 */
export function checkToolCall(
  tool: string,
  input: Record<string, unknown>,
): TripwireVerdict {
  if (tool === "write" || tool === "edit") {
    const path = String(input.path ?? "");
    if (path && isNonAgentPath(path)) {
      return { verdict: "block", reason: systemTreeReason() };
    }
    return { verdict: "allow" };
  }
  if (tool === "read" || tool === "grep" || tool === "find" || tool === "ls") {
    const path = String(input.path ?? "");
    if (path && readResolvesIntoNonAgentPath(path)) {
      return { verdict: "block", reason: systemTreeReason() };
    }
    return { verdict: "allow" };
  }
  if (tool === "browser_open") {
    const raw = String(input.url ?? "").trim();
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    try {
      const url = new URL(withScheme);
      const host = url.hostname.toLowerCase();
      if (CONCIERGE_ORIGIN) {
        try {
          const conciergeHost = new URL(CONCIERGE_ORIGIN).hostname.toLowerCase();
          if (host === conciergeHost) {
            return {
              verdict: "block",
              reason: "refused: the agent never talks to the concierge directly — that is the gateway's job",
            };
          }
        } catch {
          /* misconfigured CONCIERGE_URL: nothing to match */
        }
      }
      if ((host === "127.0.0.1" || host === "localhost") && url.port === "9222") {
        return {
          verdict: "block",
          reason: "refused: the agent drives the browser through its browser_* tools, never the CDP endpoint directly",
        };
      }
    } catch {
      /* unparsable URL: the allowlist gate asks */
    }
    return { verdict: "allow" };
  }
  return { verdict: "allow" };
}
