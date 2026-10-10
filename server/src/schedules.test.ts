import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// schedules.ts reads DATA_DIR at import (from state.js) — set env first.
const DIR = mkdtempSync(join(tmpdir(), "waddle-sched-"));
process.env.DATA_DIR = DIR;
import type { Schedule } from "./schedules.js";
const {
  createSchedule, listSchedules, cancelSchedule, nextDueMs, dueSchedules,
  dueSoon, markRun, activeSchedules, replaceAllSchedules, seedSchedules,
} = await import("./schedules.js");

test.after(() => rmSync(DIR, { recursive: true, force: true }));

const NOW = Date.parse("2026-10-10T12:00:00Z");

test("create requires the work fields and a time shape", () => {
  assert.throws(() => createSchedule({ title: "", prompt: "x", everyMs: 60000 }));
  assert.throws(() => createSchedule({ title: "t", prompt: "x" }));
  assert.throws(() => createSchedule({ title: "t", prompt: "x", everyMs: 1000 })); // sub-minute floor
  assert.throws(() => createSchedule({ title: "t", prompt: "x", at: "not-a-date" }));
  const s = createSchedule({ title: "t", prompt: "x", at: "2026-10-11T09:00:00Z" });
  assert.match(s.id, /^[0-9a-f-]{36}$/);
});

test("one-shot: future not due, past un-run overdue, run exhausts", () => {
  const future = createSchedule({ title: "f", prompt: "p", at: "2026-10-11T09:00:00Z" });
  const past = createSchedule({ title: "p", prompt: "p", at: "2026-10-09T09:00:00Z" });
  const due = dueSchedules(NOW).map((s) => s.id);
  assert.ok(!due.includes(future.id));
  assert.ok(due.includes(past.id)); // overdue = fire now
  markRun(past.id);
  assert.equal(nextDueMs(listSchedules().find((s) => s.id === past.id)!, NOW), null);
  assert.ok(!dueSchedules(NOW).some((x) => x.id === past.id));
});

test("dueSoon: the sleep gate's refusal set — inside horizon, not beyond", () => {
  const near = createSchedule({ title: "near", prompt: "p", at: "2026-10-10T12:30:00Z" });
  const far = createSchedule({ title: "far", prompt: "p", at: "2026-10-20T12:00:00Z" });
  const within = dueSoon(3600_000, NOW).map((s) => s.id);
  assert.ok(within.includes(near.id), "30 min out is inside a 1 h horizon");
  assert.ok(!within.includes(far.id), "10 days out is not");
  const overdueToo = dueSoon(3600_000, Date.parse("2026-10-10T12:45:00Z")).map((s) => s.id);
  assert.ok(overdueToo.includes(near.id), "overdue counts as due-soon");
});

test("recurring: aligned from lastRun, not from now; skipped periods fire once", () => {
  const s = createSchedule({ title: "r", prompt: "p", everyMs: 3600_000 });
  const row = () => listSchedules().find((x) => x.id === s.id)!;
  const anchor = Date.parse(row().createdAt);
  // First occurrence is exactly one period after creation.
  assert.equal(nextDueMs(row(), anchor), anchor + 3600_000);
  // Not due before the first period elapses.
  assert.ok(!dueSchedules(anchor).some((x) => x.id === s.id));
  // Machine slept 3 periods: due (once), never N-times.
  assert.ok(dueSchedules(anchor + 3 * 3600_000).some((x) => x.id === s.id));
  // markRun stamps wall-clock now; the next occurrence rides from there.
  markRun(s.id);
  const fired = row();
  const wallNow = Date.parse(fired.lastRun!);
  assert.ok(wallNow >= anchor, "fired at/after the slept-past due");
  assert.equal(nextDueMs(fired, wallNow), wallNow + 3600_000);
  assert.ok(!dueSchedules(wallNow + 3599_000).some((x) => x.id === s.id));
  assert.ok(dueSchedules(wallNow + 3601_000).some((x) => x.id === s.id));
});

test("cancel removes the row entirely", () => {
  const s = createSchedule({ title: "c", prompt: "p", everyMs: 60000 });
  assert.equal(cancelSchedule(s.id), true);
  assert.equal(cancelSchedule(s.id), false);
  assert.ok(!activeSchedules().some((x) => x.id === s.id));
});

test("persistence round-trips through the file (shelved with the machine)", () => {
  createSchedule({ title: "persist", prompt: "p", at: "2027-01-01T00:00:00Z" });
  const raw = JSON.parse(readFileSync(join(DIR, "schedules.json"), "utf8")) as Array<{ title: string }>;
  assert.ok(raw.some((s) => s.title === "persist"));
});

test("seedSchedules merges by id (credential rows are fresher) and adds new rows", () => {
  const a = createSchedule({ title: "keep", prompt: "p", at: "2030-01-01T00:00:00Z" });
  const stale = { ...a, lastRun: "2020-01-01T00:00:00Z", enabled: false }; // the credential's truth
  seedSchedules([stale, { id: "new-1", title: "chained", prompt: "p2", enabled: true, createdAt: "2030-01-01T00:00:00Z", everyMs: 3_600_000 } as Schedule]);
  const all = listSchedules();
  assert.equal(all.find((x) => x.id === a.id)?.enabled, false, "credential row replaced the local copy");
  assert.ok(all.some((x) => x.id === "new-1"), "postbox-only row added (agent chaining survives)");
});

test("replaceAllSchedules overwrites wholesale (the postbox merge writer)", () => {
  replaceAllSchedules([{ id: "only", title: "t", prompt: "p", enabled: false, createdAt: "2030-01-01T00:00:00Z" } as Schedule]);
  assert.deepEqual(listSchedules().map((x) => x.id), ["only"]);
  assert.equal(listSchedules()[0]?.enabled, false, "done-marker written as-is");
});
