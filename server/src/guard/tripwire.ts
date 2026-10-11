/**
 * The tripwires: pattern checks at critical moments that catch EGREGIOUS
 * calls — system destruction, gateway kills, the agent turning itself
 * into a concierge client. This is the catch-and-signal layer, not the
 * enforcement layer: a determined agent can obfuscate past any regex,
 * and that is fine by design (the kernel boundary is slice 2; the point
 * is that accidents and injected nonsense fail loudly with a clear
 * reason instead of mysteriously).
 *
 * Slice 1 ships this unwired; slice 3 routes the tool_call hook through
 * it. Verdicts: allow (default — the playpen is permissive), block
 * (egregious, reason reaches the agent), ask (gray + a human attached;
 * autonomous mode blocks what interactive mode would ask).
 */
import { resolve } from "node:path";
import { DATA_DIR, SYSTEM_PATHS, systemAbsPaths } from "./policy.js";

export type TripwireVerdict =
  | { verdict: "allow" }
  | { verdict: "block"; reason: string }
  | { verdict: "ask"; reason: string };

const CONCIERGE_ORIGIN = process.env.CONCIERGE_URL ?? "";

/** Kill shots at the gateway or the browser bridge. */
const KILL_PATTERN = /\b(?:pkill|killall)\b[^\n|;&]*\b(?:node|chromium|chrome|waddle)\b/;

/** Commands that destroy or rewrite what they touch. */
const DESTRUCTIVE_VERB = /\b(?:rm|rmdir|mv|chmod|chown|truncate|dd|shred|tee)\b/;

/** System tree mentioned relatively from the workspace (the bash cwd). */
const RELATIVE_ESCAPE = new RegExp(`\\.\\./(?:${SYSTEM_PATHS.join("|")})\\b`);

/** DATA_DIR exactly (not as a prefix of an agent root like /data/workspace). */
const DATA_DIR_EXACT = new RegExp(`${escapeRegex(DATA_DIR)}(?![\\w/])`);

/** Redirection whose TARGET is a system entry (`> /data/schedules.json`).
 *  DATA_DIR itself is excluded — redirects into /data/workspace are the
 *  playpen's business. */
const REDIRECT_TO_SYSTEM = systemAbsPaths().map(
  (p) => new RegExp(`>\\s*["']?[^&|;>]*${escapeRegex(p)}`),
);

/** Network verbs — the concierge check only cares about these. */
const NET_VERB = /\b(?:curl|wget|nc|ncat|socat)\b/;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Does this shell command aim at the system tree? Reads (cat, grep) of
 *  system paths are NOT caught here — the egregious class is destruction;
 *  reading is slice 2's uid boundary and slice 3's policy question. */
function aimsAtSystemTree(command: string): boolean {
  if (RELATIVE_ESCAPE.test(command)) return true;
  if (DATA_DIR_EXACT.test(command)) return true; // rm -rf /data itself
  return systemAbsPaths().some((p) => command.includes(p));
}

function checkCommand(command: string): TripwireVerdict | null {
  if (KILL_PATTERN.test(command)) {
    return {
      verdict: "block",
      reason: "refused: that would kill the waddle gateway or its browser — the machine's own processes are not yours to stop",
    };
  }
  if (DESTRUCTIVE_VERB.test(command) && aimsAtSystemTree(command)) {
    return {
      verdict: "block",
      reason: `refused: that touches waddle's system state (${DATA_DIR}/{${SYSTEM_PATHS.join(",")}}) — the log, verifier, transcripts, schedules, and browser profile are the system's, not the workspace's`,
    };
  }
  if (REDIRECT_TO_SYSTEM.some((re) => re.test(command))) {
    return {
      verdict: "block",
      reason: `refused: that redirects into waddle's system state (${DATA_DIR}/{${SYSTEM_PATHS.join(",")}}) — write to the workspace instead`,
    };
  }
  if (CONCIERGE_ORIGIN && NET_VERB.test(command)) {
    const host = safeHost(CONCIERGE_ORIGIN);
    // Case-insensitive (the URL parser lowercases the configured host; a
    // curled host can be any case). Substring, not authority-parsed: a
    // command that merely MENTIONS the concierge host while curling
    // elsewhere false-positives, and that is the safe direction for an
    // egregious-class check — the reason string tells the agent why.
    if (host && command.toLowerCase().includes(host)) {
      return {
        verdict: "block",
        reason: "refused: the agent never talks to the concierge directly — that is the gateway's job",
      };
    }
  }
  return null;
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** Is this path (write/edit target) inside the system tree? Relative
 *  paths are workspace-relative, as in the file tools. The platform's
 *  resolve() does the traversal math — hand-rolled normalization is how
 *  `a/../../log` evades (review-caught). */
function isSystemPath(path: string): boolean {
  const full = resolve(DATA_DIR, "workspace", path); // absolute paths ignore the base
  if (full === DATA_DIR || full.startsWith(`${DATA_DIR}/`)) {
    const rest = full === DATA_DIR ? "" : full.slice(DATA_DIR.length + 1);
    const first = rest.split("/")[0] ?? "";
    return rest === "" || (SYSTEM_PATHS as readonly string[]).includes(first);
  }
  return false;
}

/**
 * The dispatch check. Unknown tools allow — the playpen defaults open;
 * new egregious patterns are added as they are seen in the wild.
 */
export function checkToolCall(
  tool: string,
  input: Record<string, unknown>,
): TripwireVerdict {
  if (tool === "bash" || tool === "powershell") {
    const command = String(input.command ?? "");
    return checkCommand(command) ?? { verdict: "allow" };
  }
  if (tool === "write" || tool === "edit") {
    const path = String(input.path ?? "");
    if (path && isSystemPath(path)) {
      return {
        verdict: "block",
        reason: `refused: ${path} is waddle system state, not workspace — the log, verifier, transcripts, schedules, and browser profile are the system's`,
      };
    }
    return { verdict: "allow" };
  }
  return { verdict: "allow" };
}
