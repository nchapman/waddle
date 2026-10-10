/**
 * The timer table — the concierge's entire state, extracted so its
 * semantics are testable without the service or a platform backend.
 *
 * Contract (the agents depend on every clause):
 *  - stop rows are singleton-per-instance: a write replaces (debounce)
 *  - wake rows are job-keyed one-shots: a write replaces that job's row
 *  - due_ms 0 cancels the row (stop or wake)
 *  - dues far beyond setTimeout's 2^31-1 ms limit chain re-arms instead of
 *    overflowing to fire-now
 *  - a replaced or cancelled row never fires: chains verify row identity
 *    (verb, jobId, due) at every hop
 *  - everything memory-only: the object is the truth, nothing persists
 */
import { randomBytes } from "node:crypto";

/** setTimeout delays are 32-bit; a longer one silently fires at ~1 ms. */
const MAX_DELAY = 2 ** 31 - 1;

interface Entry {
  sessionToken: string;
  lastContact: number;
  stopRow?: { due: number };
  wakeRows: Map<string, { due: number }>;
}

interface TableSnapshot {
  instance: string;
  last_contact_ago_ms: number;
  stop_due_in_ms: number | null;
  wake_jobs: { job_id: string; due_in_ms: number }[];
}

export function createTable(onStop: (instance: string) => void, onWake: (instance: string, jobId: string) => void) {
  const table = new Map<string, Entry>();

  function entryFor(instance: string): Entry {
    let e = table.get(instance);
    if (!e) {
      e = { sessionToken: randomBytes(32).toString("base64url"), lastContact: Date.now(), wakeRows: new Map() };
      table.set(instance, e);
    }
    return e;
  }

  /** Is this exact row still live? Replacements change `due` and stale
   *  chains must die with their row. */
  function rowIsLive(instance: string, verb: "stop" | "wake", jobId: string | undefined, due: number): boolean {
    const e = table.get(instance);
    if (!e) return false;
    if (verb === "stop") return e.stopRow?.due === due;
    return e.wakeRows.get(jobId!)?.due === due;
  }

  /** Fire `verb` at absolute `due`: chain capped timers, verifying row
   *  identity at every hop (a replaced row's old chain no-ops). */
  function arm(instance: string, verb: "stop" | "wake", jobId: string | undefined, due: number) {
    const step = () => {
      if (!rowIsLive(instance, verb, jobId, due)) return; // replaced/cancelled
      const remaining = due - Date.now();
      if (remaining <= 0) {
        // Fire under a final identity check, then the row is spent.
        if (verb === "stop") {
          const e = table.get(instance);
          if (e?.stopRow?.due === due) e.stopRow = undefined;
          onStop(instance);
        } else {
          const e = table.get(instance);
          if (e?.wakeRows.get(jobId!)?.due === due) e.wakeRows.delete(jobId!);
          onWake(instance, jobId!);
        }
        return;
      }
      setTimeout(step, Math.min(remaining, MAX_DELAY)).unref();
    };
    step();
  }

  return {
    /** Handshake/mint: the session token (idempotent); touching counts as contact. */
    mintSession(instance: string): string {
      const e = entryFor(instance);
      e.lastContact = Date.now();
      return e.sessionToken;
    },
    entry(instance: string): Entry | undefined {
      return table.get(instance);
    },
    /** Stop row: replace = debounce; dueMs 0 = cancel. */
    setStop(instance: string, dueMs: number): "replaced" | "cleared" {
      const e = entryFor(instance);
      e.stopRow = undefined; // old chain no-ops on its next identity check
      if (dueMs <= 0) return "cleared";
      e.stopRow = { due: Date.now() + dueMs };
      arm(instance, "stop", undefined, e.stopRow.due);
      return "replaced";
    },
    /** Wake row: job-keyed replace; dueMs 0 = cancel that job. */
    setWake(instance: string, jobId: string, dueMs: number): "replaced" | "cleared" {
      const e = entryFor(instance);
      e.wakeRows.delete(jobId); // old chain no-ops on its next identity check
      if (dueMs <= 0) return "cleared";
      e.wakeRows.set(jobId, { due: Date.now() + dueMs });
      arm(instance, "wake", jobId, e.wakeRows.get(jobId)!.due);
      return "replaced";
    },
    /** User present: drop any pending stop row, touch the entry. */
    userWake(instance: string): void {
      const e = entryFor(instance);
      e.stopRow = undefined; // pending chain no-ops on its identity check
      e.lastContact = Date.now();
    },
    countRows(): number {
      let n = 0;
      for (const e of table.values()) n += (e.stopRow ? 1 : 0) + e.wakeRows.size;
      return n;
    },
    snapshot(): TableSnapshot[] {
      return [...table.entries()].map(([instance, e]) => ({
        instance,
        last_contact_ago_ms: Date.now() - e.lastContact,
        stop_due_in_ms: e.stopRow ? e.stopRow.due - Date.now() : null,
        wake_jobs: [...e.wakeRows.entries()].map(([id, r]) => ({ job_id: id, due_in_ms: r.due - Date.now() })),
      }));
    },
  };
}

