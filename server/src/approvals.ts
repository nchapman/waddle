/**
 * The ask-gate: the agent proposes, only the gate executes.
 *
 * There is no bash (codemode's sandbox replaced the shell), so the askable
 * surface is just the browser's URL gate: allowlisted domains pass,
 * everything else asks — the browser shows the exact URL and approve/deny
 * decides. The file tools never ask: their workspace containment and the
 * system-tree tripwires are deterministic, so they answer on their own.
 *
 * Autonomous runs (scheduled fires, no human attached) convert every ask
 * into an immediate block with a reason — a 180s wait for a dialog nobody
 * can see is worse than a clear no.
 *
 * The gate pauses the turn: pi's tool_call handler awaits our promise,
 * which the browser resolves (or the timeout denies).
 */
import { checkToolCall } from "./guard/tripwire.js";

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

const TIMEOUT_MS = 180_000;

// The pending map keeps the tool name so approval outcomes can report
// which verb was decided (and the timer so a resolved call stops it).
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

/** Autonomous-turn state: set by the scheduled-run path so the gate can
 *  fail fast instead of waiting on a dialog no one can answer. */
let autonomousTurn = false;
export function setAutonomousTurn(on: boolean): void {
  autonomousTurn = on;
}
export function isAutonomousTurn(): boolean {
  return autonomousTurn;
}

/** The full gate decision for a tool call: tripwire blocks first, then
 *  the ask set (browser_open off-allowlist), with autonomous runs
 *  converting asks into blocks. Pure except for the autonomous flag. */
export function gateDecision(
  toolName: string,
  input: Record<string, unknown>,
): { action: "allow" } | { action: "ask"; reason: string } | { action: "block"; reason: string } {
  const trip = checkToolCall(toolName, input);
  if (trip.verdict === "block") return { action: "block", reason: trip.reason };
  if (toolName === "browser_open" && !allowlistedBrowserUrl(input)) {
    if (autonomousTurn) {
      return {
        action: "block",
        reason: "refused: that domain is not on the allowlist, and autonomous runs have no user to approve it — ask the user to open it themselves, or suggest adding the domain to the allowlist",
      };
    }
    return { action: "ask", reason: "the browser shows the exact URL; approve or deny decides" };
  }
  return { action: "allow" };
}

/** Does this browser_open input target an allowlisted host? */
function allowlistedBrowserUrl(input: Record<string, unknown>): boolean {
  const raw = String(input.url ?? "").trim();
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const host = new URL(withScheme).hostname.toLowerCase();
    if (host && BROWSER_ALLOWLIST.some((d) => host === d || host.endsWith(`.${d}`))) return true;
  } catch {
    /* unparsable URL: ask */
  }
  return false;
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
