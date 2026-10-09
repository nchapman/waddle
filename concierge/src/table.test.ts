import { test } from "node:test";
import assert from "node:assert/strict";
import { createTable } from "./table.js";

/** Collecting harness: fires land as tuples we can await/assert. */
function harness() {
  const stops: string[] = [];
  const wakes: [string, string][] = [];
  const t = createTable(
    (i) => stops.push(i),
    (i, j) => wakes.push([i, j]),
  );
  return { t, stops, wakes };
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("stop rows are singleton: replace debounces, the old due never fires", async () => {
  const { t, stops } = harness();
  t.setStop("waddle", 40);
  t.setStop("waddle", 120); // replaced: the 40ms fire must be dead
  await tick(80);
  assert.equal(stops.length, 0, "replaced row's old timer must not fire");
  await tick(80);
  assert.deepEqual(stops, ["waddle"]);
});

test("due 0 cancels: nothing fires", async () => {
  const { t, stops } = harness();
  t.setStop("waddle", 30);
  t.setStop("waddle", 0);
  await tick(80);
  assert.equal(stops.length, 0);
});

test("wake rows are job-keyed one-shots; cancel is per-job", async () => {
  const { t, wakes } = harness();
  t.setWake("waddle", "job-a", 30);
  t.setWake("waddle", "job-b", 60);
  t.setWake("waddle", "job-a", 0); // cancel a, b unaffected
  await tick(100);
  assert.deepEqual(wakes, [["waddle", "job-b"]]);
});

test("wake replace moves the due; the old one never fires", async () => {
  const { t, wakes } = harness();
  t.setWake("waddle", "job", 30);
  t.setWake("waddle", "job", 90);
  await tick(60);
  assert.equal(wakes.length, 0);
  await tick(60);
  assert.deepEqual(wakes, [["waddle", "job"]]);
});

test("rows are spent on fire (countRows drops, re-arm works)", async () => {
  const { t, stops } = harness();
  t.setStop("waddle", 20);
  assert.equal(t.countRows(), 1);
  await tick(60);
  assert.equal(t.countRows(), 0);
  t.setStop("waddle", 20);
  await tick(60);
  assert.deepEqual(stops, ["waddle", "waddle"]);
});

test("userWake drops the pending stop row", async () => {
  const { t, stops } = harness();
  t.setStop("waddle", 30);
  t.userWake("waddle");
  await tick(80);
  assert.equal(stops.length, 0);
});

test("far-future dues chain capped timers, never overflow to fire-now", async () => {
  const { t, wakes } = harness();
  // ~25 days out would overflow setTimeout's 32-bit delay and fire at ~1ms.
  t.setWake("waddle", "far", 25 * 24 * 3600_000);
  await tick(50);
  assert.equal(wakes.length, 0, "overflow would have fired immediately");
  const far = t.snapshot().find((s) => s.instance === "waddle")?.wake_jobs.find((j) => j.job_id === "far");
  assert.ok(far && far.due_in_ms > 24 * 3600_000);
});

test("snapshot reflects live rows; sessions mint per instance", async () => {
  const { t } = harness();
  const a1 = t.mintSession("waddle");
  const a2 = t.mintSession("waddle");
  const b = t.mintSession("other");
  assert.equal(a1.sessionToken, a2.sessionToken); // idempotent mint
  assert.notEqual(a1.sessionToken, b.sessionToken);
  t.setStop("waddle", 1000);
  const snap = t.snapshot();
  assert.ok(snap.find((s) => s.instance === "waddle" && s.stop_due_in_ms !== null));
  assert.ok(snap.find((s) => s.instance === "other" && s.stop_due_in_ms === null));
});
