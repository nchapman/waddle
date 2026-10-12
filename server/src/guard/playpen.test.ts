/**
 * The playpen's ownership choreography. The mechanics run here with the
 * test process's own uid (chown-to-self is permitted unprivileged; the
 * system tree's target uid is injectable) — the REAL uid assertions
 * (agent 1100 vs root) are the container-level check: scripts/guard-verify.mjs.
 *
 * DATA_DIR is read at module load, so pin it before the dynamic import.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, chownSync, mkdirSync, symlinkSync, writeFileSync, statSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ME = process.getuid?.() ?? -1;
// macOS refuses even chown-to-self (EPERM); Linux allows it. The kernel
// boundary itself is verified in the container (scripts/guard-verify.mjs) —
// here the uid assertions run only where chown is possible at all.
const CAN_CHOWN = (() => {
  const probe = join(tmpdir(), `waddle-chown-probe-${process.pid}`);
  writeFileSync(probe, "");
  try {
    chownSync(probe, ME, ME);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { force: true });
  }
})();
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "waddle-playpen-"));
const { enforcePlaypen, enforcePlaypenInto } = await import("./playpen.js");
const { playpenActive } = await import("./policy.js");

const MODE = (p: string) => statSync(p).mode & 0o7777; // includes the sticky bit

test("enforce: creates the playpen with the right shapes (uid-injected mechanics)", () => {
  const report = enforcePlaypenInto(process.env.DATA_DIR!, ME, ME, ME);
  assert.equal(report.enforced, CAN_CHOWN, report.reason ?? "chown capability decides full enforcement");
  assert.equal(MODE(process.env.DATA_DIR!), 0o755, "DATA root is traversable (the volume shape)");
  assert.equal(MODE(join(process.env.DATA_DIR!, "workspace")), 0o700);
  assert.equal(MODE(join(process.env.DATA_DIR!, "browser")), 0o700);
  assert.equal(MODE(join(process.env.DATA_DIR!, "home")), 0o700);
  assert.equal(MODE(join(process.env.DATA_DIR!, "tmp")), 0o1777, "tmp is sticky shared scratch");
  assert.equal(report.agentUid, ME);
  assert.equal(report.browserUid, ME);
  if (CAN_CHOWN) {
    assert.equal(statSync(join(process.env.DATA_DIR!, "workspace")).uid, ME, "ownership hands over where chown works");
  }
});

test("enforce: tightens a pre-existing loose system tree", () => {
  const log = join(process.env.DATA_DIR!, "log");
  mkdirSync(log, { recursive: true });
  chmodSync(log, 0o755); // what an old archive might restore
  writeFileSync(join(log, "events.jsonl"), "x", { mode: 0o644 });
  const sessions = join(process.env.DATA_DIR!, "sessions");
  mkdirSync(sessions, { recursive: true });
  chmodSync(sessions, 0o755);
  writeFileSync(join(sessions, "s.jsonl"), "x", { mode: 0o644 });

  const report = enforcePlaypenInto(process.env.DATA_DIR!, ME, ME, ME);
  assert.equal(report.enforced, CAN_CHOWN, report.reason ?? "chown capability decides full enforcement");
  assert.equal(MODE(log), 0o700);
  assert.equal(MODE(join(log, "events.jsonl")), 0o600);
  assert.equal(MODE(sessions), 0o700);
  assert.equal(MODE(join(sessions, "s.jsonl")), 0o600);
});

test("enforce: never follows symlinks — a planted link must not re-own or re-mode its target", () => {
  const outside = join(tmpdir(), `waddle-playpen-outside-${process.pid}`);
  writeFileSync(outside, "system file", { mode: 0o644 });
  try {
    const log = join(process.env.DATA_DIR!, "log");
    mkdirSync(log, { recursive: true });
    symlinkSync(outside, join(log, "escape")); // planted during the archive's life
    const report = enforcePlaypenInto(process.env.DATA_DIR!, ME, ME, ME);
    assert.equal(report.enforced, CAN_CHOWN, report.reason ?? "chown capability decides full enforcement");
    assert.equal(MODE(outside), 0o644, "the walker must not chmod through the link");
  } finally {
    rmSync(outside, { force: true });
  }
});

test("enforce: idempotent — a second run is a no-op with the same report", () => {
  const first = enforcePlaypenInto(process.env.DATA_DIR!, ME, ME, ME);
  const second = enforcePlaypenInto(process.env.DATA_DIR!, ME, ME, ME);
  assert.equal(second.enforced, first.enforced);
  assert.equal(second.agentUid, first.agentUid);
});

test("enforcePlaypen degrades honestly when unprivileged", () => {
  if (ME === 0) return; // running as root (container): the real path is covered by guard-verify
  const report = enforcePlaypen();
  assert.equal(report.enforced, false);
  assert.match(report.reason ?? "", /root/, "the reason must say what is missing");
  assert.equal(report.agentUid, 1100, "the configured uids are still reported (they ship in /health)");
});

test("playpenActive probes rather than trusts uid 0 (the Tinfoil lesson)", () => {
  if (ME === 0) return; // root+caps is guard-verify's branch: the probe must succeed there
  // Unprivileged runner: uid != 0, so the probe refuses before any chown.
  // The caps-dropped-root case (uid 0, chown EPERM) cannot be staged without
  // privileges — the platform itself is that test, and /health's reason
  // string distinguishes it from the dev-host case ("platform dropped
  // capabilities" vs "not running as root"). What this pins: the verdict
  // is a PROBE now, cached, and a false uid-0 reading can never arm the
  // uid spawn on a box that cannot chown.
  assert.equal(playpenActive(), false, "no boundary is claimed where it cannot be enforced");
});

test("enforce: refuses a symlinked playpen top — never chmod/chown through it", () => {
  const outside = join(tmpdir(), `waddle-playpen-top-out-${process.pid}`);
  writeFileSync(outside, "sys", { mode: 0o644 });
  try {
    // A restore-like hostile archive member: browser arrives as a symlink.
    rmSync(join(process.env.DATA_DIR!, "browser"), { recursive: true, force: true });
    symlinkSync(outside, join(process.env.DATA_DIR!, "browser"));
    const report = enforcePlaypenInto(process.env.DATA_DIR!, ME, ME, ME);
    assert.equal(report.enforced, false, "a hostile entry must surface, not pass silently");
    assert.match(report.reason ?? "", /symlink/);
    assert.equal(MODE(outside), 0o644, "never chmod through the link");
    // Per-entry isolation: everything else is still enforced.
    assert.equal(MODE(join(process.env.DATA_DIR!, "tmp")), 0o1777);
    assert.equal(MODE(join(process.env.DATA_DIR!, "log")), 0o700);
  } finally {
    rmSync(outside, { force: true });
  }
});

test("enforce: a dangling workspace symlink is noted, the rest still enforced", () => {
  const ws = join(process.env.DATA_DIR!, "workspace");
  rmSync(ws, { recursive: true, force: true });
  symlinkSync("/nonexistent-waddle-probe", ws); // mkdir would throw EEXIST
  try {
    const report = enforcePlaypenInto(process.env.DATA_DIR!, ME, ME, ME);
    assert.equal(report.enforced, false);
    assert.equal(MODE(join(process.env.DATA_DIR!, "tmp")), 0o1777, "the rest still enforced");
    assert.equal(MODE(join(process.env.DATA_DIR!, "sessions")), 0o700, "system tree still tightened");
  } finally {
    rmSync(ws, { force: true }); // remove the symlink itself
  }
});

test("enforce: a symlinked system entry is refused and surfaced, not silently skipped", () => {
  const log = join(process.env.DATA_DIR!, "log");
  rmSync(log, { recursive: true, force: true });
  // A hostile archive points "the log" into the agent's tree.
  symlinkSync(join(process.env.DATA_DIR!, "workspace"), log);
  try {
    const report = enforcePlaypenInto(process.env.DATA_DIR!, ME, ME, ME);
    assert.equal(report.enforced, false, "a symlinked system entry must fail the report");
    assert.match(report.reason ?? "", /symlink/);
    // The rest still enforced (per-entry isolation).
    assert.equal(MODE(join(process.env.DATA_DIR!, "tmp")), 0o1777);
  } finally {
    rmSync(log, { force: true }); // remove the link, not its target
  }
});

test("enforce: an INTERIOR symlink in a system entry is surfaced, not silently skipped", () => {
  const log = join(process.env.DATA_DIR!, "log");
  rmSync(log, { recursive: true, force: true });
  mkdirSync(log, { recursive: true });
  writeFileSync(join(log, "events.jsonl"), "sealed");
  // A hostile archive redirects one system file into the agent's tree.
  rmSync(join(log, "events.jsonl"));
  symlinkSync(join(process.env.DATA_DIR!, "workspace", "fake-log"), join(log, "events.jsonl"));
  try {
    const report = enforcePlaypenInto(process.env.DATA_DIR!, ME, ME, ME);
    assert.equal(report.enforced, false, "an interior system symlink must fail the report");
    assert.match(report.reason ?? "", /symlink/);
    // The real siblings still tightened.
    writeFileSync(join(log, "real.txt"), "x");
  } finally {
    rmSync(log, { recursive: true, force: true }); // removes the link too
  }
});

after(() => rmSync(process.env.DATA_DIR!, { recursive: true, force: true }));
