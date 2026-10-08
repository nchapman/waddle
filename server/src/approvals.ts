/**
 * The ask-gate: the agent proposes, only the gate executes.
 *
 * Rules (the read/write halves of the three rules):
 *   - read/grep/find/ls: auto-allow
 *   - write/edit: auto-allow when the target stays inside the workspace
 *   - bash: ASK — arbitrary commands are the open-ended surface; the
 *     browser shows the exact parameters and approve/deny decides.
 *
 * The gate pauses the turn: pi's tool_call handler awaits our promise,
 * which the browser resolves (or the timeout denies).
 */

export interface ApprovalRequest {
  type: "approval_request";
  callId: string;
  tool: string;
  input: unknown;
  at?: string;
}

export interface ApprovalOutcome {
  type: "approval";
  callId: string;
  tool: string;
  approved: boolean;
  at?: string;
}

type Emit = (event: ApprovalRequest | (ApprovalOutcome & { at: string })) => void;

// requestApproval signature keeps tool; the pending map stores it for outcomes.

import { resolve } from "node:path";

const WORKSPACE = resolve(process.env.DATA_DIR ?? "/tmp/waddle-data", "workspace");
const TIMEOUT_MS = 180_000;

const pending = new Map<string, { tool: string; resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout> }>();
let emit: Emit = () => undefined;

export function setApprovalEmitter(next: Emit): void {
  emit = next;
}

/** Broadcast seam for gate-initiated outcomes (timeouts, disconnect-denies). */
export function setOutcomeEmitter(next: (outcome: ApprovalOutcome & { at: string }) => void): void {
  outcomeEmitter = next;
}
let outcomeEmitter: (outcome: ApprovalOutcome & { at: string }) => void = () => undefined;

/** Domains the agent may open without asking (comma-separated env). */
const BROWSER_ALLOWLIST = (process.env.WADDLE_BROWSER_ALLOWLIST ?? "example.com,news.ycombinator.com,en.wikipedia.org,tinfoil.sh,localhost")
  .split(",")
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

/** Does this call need the human? */
export function needsApproval(toolName: string, input: Record<string, unknown>): boolean {
  if (toolName === "bash" || toolName === "powershell") return true;
  if (toolName === "browser_open") {
    // The URL/domain gate: allowlisted domains pass, everything else asks.
    // Same normalization as the tool itself — the model often passes bare domains.
    const raw = String(input.url ?? "").trim();
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    try {
      const host = new URL(withScheme).hostname.toLowerCase();
      if (host && BROWSER_ALLOWLIST.some((d) => host === d || host.endsWith(`.${d}`))) return false;
    } catch {
      /* unparsable URL: ask */
    }
    return true;
  }
  if (toolName === "write" || toolName === "edit") {
    // Writes auto-allow inside the workspace; anything else asks.
    return !inWorkspace(String(input.path ?? ""));
  }
  return false; // read/grep/find/ls
}

function inWorkspace(p: string): boolean {
  if (p === "") return false; // absent path: ask, never assume
  // Relative paths are workspace-relative (that is the tools' cwd);
  // resolve() collapses traversal, so ../ escapes fall outside.
  const full = p.startsWith("/") ? resolve(p) : resolve(WORKSPACE, p);
  return full === WORKSPACE || full.startsWith(`${WORKSPACE}/`);
}

/** Pause for the browser's verdict. Resolves false on timeout. */
export function requestApproval(callId: string, tool: string, input: unknown): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(callId);
      outcomeEmitter({ type: "approval", callId, tool, approved: false, at: new Date().toISOString() });
      resolve(false);
    }, TIMEOUT_MS);
    pending.set(callId, {
      tool,
      resolve: (ok) => {
        clearTimeout(timer);
        resolve(ok);
      },
      timer,
    });
    emit({ type: "approval_request", callId, tool, input, at: new Date().toISOString() });
  });
}

/** The browser spoke. Unblocks the paused call; returns the tool name or null. */
export function resolveApproval(callId: string, approved: boolean): string | null {
  const entry = pending.get(callId);
  if (!entry) return null;
  pending.delete(callId);
  entry.resolve(approved);
  return entry.tool;
}

/** No clients left / shutdown: deny everything still waiting. */
export function denyAllPending(): void {
  for (const [id, entry] of pending) {
    pending.delete(id);
    clearTimeout(entry.timer);
    outcomeEmitter({ type: "approval", callId: id, tool: entry.tool, approved: false, at: new Date().toISOString() });
    entry.resolve(false);
  }
}
