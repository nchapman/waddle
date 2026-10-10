import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// DATA_DIR is read at module load — scratch tree first.
const dir = mkdtempSync(join(tmpdir(), "waddle-prefs-"));
process.env.DATA_DIR = dir;
const { getPreferences, setPreferences, backgroundTasksEnabled } = await import("./preferences.js");

test("defaults to tier 0 — no delegation without an explicit opt-in", () => {
  assert.equal(backgroundTasksEnabled(), false);
  assert.deepEqual(getPreferences(), { background: false });
});

test("opting in records the acceptance time (audit trail)", () => {
  const prefs = setPreferences({ background: true });
  assert.equal(prefs.background, true);
  assert.ok(prefs.backgroundAcceptedAt, "warning acceptance is timestamped");
  assert.equal(backgroundTasksEnabled(), true);
  assert.ok(existsSync(join(dir, "preferences.json")), "persists in DATA_DIR — rides the snapshot");
});

test("turning it off drops the timestamp (tier 0 has nothing to revoke)", () => {
  const prefs = setPreferences({ background: false });
  assert.equal(prefs.background, false);
  assert.equal(prefs.backgroundAcceptedAt, undefined);
});

test("survives a reboot — the file is the truth, the cache is a courtesy", async () => {
  setPreferences({ background: true });
  // Simulate a fresh process: same module path, cache dropped.
  const fresh = await import("./preferences.js?reboot=" + Date.now());
  assert.equal(fresh.backgroundTasksEnabled(), true);
});

test("corrupt or non-boolean file degrades to tier 0, never crashes the boot", async () => {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(dir, "preferences.json"), "{ not json", "utf8");
  const fresh = await import("./preferences.js?corrupt=" + Date.now());
  assert.equal(fresh.backgroundTasksEnabled(), false);
});

test("cleans up scratch DATA_DIR", () => {
  rmSync(dir, { recursive: true, force: true });
});
