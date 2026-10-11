/**
 * Wake-boot credential file tests — the DEV arm of wake autonomy
 * (memory-only escrow is the concierge's; this is the mounted-DATA_DIR
 * fallback a dev compose machine boots from). Contract: arm writes
 * exactly what was armed, read tolerates absent/corrupt/empty files
 * (a stale credential must degrade to a locked boot, never a crash),
 * and clear disarms.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "waddle-wakeboot-"));
process.env.DATA_DIR = dir;
const { armWakeCredential, readWakeCredential, clearWakeCredential, autonomyEnabled } = await import("./wakeboot.js");
const WAKE_PATH = join(dir, "wake-credential.json");

test("autonomyEnabled is an explicit env opt-in, never a default", () => {
  delete process.env.WADDLE_WAKE_AUTONOMY;
  assert.equal(autonomyEnabled(), false);
  process.env.WADDLE_WAKE_AUTONOMY = "1";
  assert.equal(autonomyEnabled(), true);
  delete process.env.WADDLE_WAKE_AUTONOMY;
});

test("arm → read round-trips the full credential (secret, work, snapshot)", () => {
  const cred = {
    secret: "czZlY3JldA==",
    schedules: [{ id: "s1", title: "t", prompt: "p", enabled: true, createdAt: "2026-10-11T00:00:00Z" }],
    snapshot: "c25hcHNob3Q=",
    inferenceKey: "tk-dev",
  };
  armWakeCredential(cred);
  assert.deepEqual(readWakeCredential(), cred);
});

test("an absent file reads as null — a locked boot, not a crash", () => {
  clearWakeCredential();
  assert.equal(readWakeCredential(), null);
});

test("a corrupt file reads as null (stale/truncated writes degrade silently)", () => {
  writeFileSync(WAKE_PATH, "{ not json", "utf8");
  assert.equal(readWakeCredential(), null);
});

test("a credential without a real secret reads as null — nothing to unlock with", () => {
  writeFileSync(WAKE_PATH, JSON.stringify({ schedules: [] }), "utf8");
  assert.equal(readWakeCredential(), null);
  writeFileSync(WAKE_PATH, JSON.stringify({ secret: "" }), "utf8");
  assert.equal(readWakeCredential(), null);
});

test("clear disarms and is safe when nothing is armed", () => {
  armWakeCredential({ secret: "s" });
  clearWakeCredential();
  assert.equal(readWakeCredential(), null);
  clearWakeCredential(); // no throw
});

test("cleans up scratch DATA_DIR", () => {
  rmSync(dir, { recursive: true, force: true });
});
