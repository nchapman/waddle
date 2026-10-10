/**
 * Schedules — the agent's own wake-time construct.
 *
 * A schedule is future work the machine owns: while alive, an in-VM ticker
 * fires it; before death, the sleep gate registers it with the concierge
 * as a wake row (one dumb timer table — see concierge/src/index.ts). The
 * persisted file lives in DATA_DIR, so it shelves with the machine and
 * due-at-boot reseeds after a restore.
 *
 * The model is deliberately minimal: everyMs (recurring) xor at (one-shot),
 * plus the prompt — the work, phrased as a user instruction for chat().
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DATA_DIR } from "./state.js";

export interface Schedule {
  id: string;
  title: string;
  /** The work, phrased as a user instruction (fed to chat()). */
  prompt: string;
  /** Recurring period (ms) — or: */
  everyMs?: number;
  /** One-shot ISO timestamp. */
  at?: string;
  /** ISO of the last firing (recurring alignment). */
  lastRun?: string;
  enabled: boolean;
  createdAt: string;
}

const SCHEDULES_FILE = join(DATA_DIR, "schedules.json");

function readAll(): Schedule[] {
  try {
    return JSON.parse(readFileSync(SCHEDULES_FILE, "utf8")) as Schedule[];
  } catch (e) {
    // Only "no file yet" is a normal empty table. Anything else (EIO,
    // EACCES, truncated JSON) would silently discard every booked wake —
    // quarantine the damaged file so it is inspectable, never overwritten.
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    try {
      renameSync(SCHEDULES_FILE, `${SCHEDULES_FILE}.corrupt-${Date.now()}`);
    } catch {
      /* quarantine is best-effort */
    }
    return [];
  }
}

function writeAll(schedules: Schedule[]): void {
  mkdirSync(DATA_DIR, { recursive: true });
  // Atomic swap: a crash mid-write must never leave a truncated table.
  const tmp = `${SCHEDULES_FILE}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(schedules, null, 2));
  renameSync(tmp, SCHEDULES_FILE);
}

export function createSchedule(input: {
  title: string;
  prompt: string;
  everyMs?: number;
  at?: string;
}): Schedule {
  if (!input.title?.trim() || !input.prompt?.trim()) throw new Error("title and prompt required");
  const s: Schedule = {
    id: randomUUID(),
    title: input.title.trim(),
    prompt: input.prompt.trim(),
    enabled: true,
    createdAt: new Date().toISOString(),
  };
  if (input.everyMs !== undefined) {
    if (!Number.isFinite(input.everyMs) || input.everyMs < 60_000) {
      throw new Error("everyMs must be >= 60000 (a minute is the floor)");
    }
    s.everyMs = input.everyMs;
  } else if (input.at !== undefined) {
    const t = Date.parse(input.at);
    if (Number.isNaN(t)) throw new Error("at must be an ISO timestamp");
    s.at = new Date(t).toISOString();
  } else {
    throw new Error("either everyMs (recurring) or at (one-shot) is required");
  }
  const all = readAll();
  all.push(s);
  writeAll(all);
  return s;
}

export function listSchedules(): Schedule[] {
  return readAll();
}

/** Cancel = remove (a cancelled row carries no wake-timer debt). */
export function cancelSchedule(id: string): boolean {
  const all = readAll();
  const next = all.filter((s) => s.id !== id);
  if (next.length === all.length) return false;
  writeAll(next);
  return true;
}

/** Next occurrence as epoch ms, or null when done (past one-shot already
 *  run, or disabled). A past un-run one-shot is OVERDUE (returns its time,
 *  which is <= now) — due() treats it as fire-now. */
export function nextDueMs(s: Schedule, now = Date.now()): number | null {
  if (!s.enabled) return null;
  if (s.everyMs !== undefined) {
    // Align to the period from lastRun (or creation), never from "now":
    // a machine that sleeps past several periods fires once, not N times.
    const anchor = Date.parse(s.lastRun ?? s.createdAt);
    return anchor + s.everyMs;
  }
  if (s.at !== undefined) {
    const t = Date.parse(s.at);
    return s.lastRun ? null : t;
  }
  return null;
}

/** Enabled schedules whose next occurrence is due at `now`. */
export function dueSchedules(now = Date.now()): Schedule[] {
  return readAll().filter((s) => {
    const d = nextDueMs(s, now);
    return d !== null && d <= now;
  });
}

/** Enabled schedules due within `horizonMs` of `now` — the sleep gate's
 *  refusal set: dying into one of these without a wake row loses work. */
export function dueSoon(horizonMs: number, now = Date.now()): Schedule[] {
  return readAll().filter((s) => {
    const d = nextDueMs(s, now);
    return d !== null && d <= now + horizonMs;
  });
}

/** Record a firing (recurring realigns; one-shot exhausts). */
export function markRun(id: string): void {
  const all = readAll();
  const s = all.find((x) => x.id === id);
  if (!s) return;
  s.lastRun = new Date().toISOString();
  if (s.at !== undefined) s.enabled = false; // one-shot: done
  writeAll(all);
}

/** All enabled rows — the sleep gate registers a wake row for each. */
export function activeSchedules(): Schedule[] {
  return readAll().filter((s) => s.enabled);
}

/** Replace the whole table (the postbox merge path: incoming rows are
 *  newer truth — done-markers from the unattended run). */
export function replaceAllSchedules(schedules: Schedule[]): void {
  writeAll(schedules);
}

/** Seed rows from the wake credential (a fresh volume has no table).
 *  Merge by id — a dev volume may already hold the rows. */
export function seedSchedules(incoming: Schedule[]): void {
  if (incoming.length === 0) return;
  const all = readAll();
  const byId = new Map(all.map((s) => [s.id, s]));
  for (const row of incoming) byId.set(row.id, row); // credential rows are fresher
  writeAll([...byId.values()]);
}
