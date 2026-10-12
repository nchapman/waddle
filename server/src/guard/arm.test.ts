/**
 * Arm hygiene (slice 4): the gate between a machine's state and its
 * escrow. The playpen verdict is pure (root/dev branches exercised
 * without privileges); the snapshot verdict runs against real tar
 * bodies built by the production pack path (tar + zstd CLIs), so the
 * member walk sees exactly the format the enclave produces — GNU long
 * names on Linux, pax on macOS, both covered.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DATA_DIR = mkdtempSync(join(tmpdir(), "waddle-arm-"));
process.env.DATA_DIR = DATA_DIR;

const { createArchive, decodeArchive } = await import("../archive.js");
const { playpenGate, checkSnapshotHygiene, walkTar } = await import("./arm.js");
const { registerSecret, unregisterSecret } = await import("./policy.js");

const report = (enforced: boolean, reason?: string) => ({
  enforced,
  ...(reason ? { reason } : {}),
  agentUid: 1100,
  browserUid: 1101,
  at: new Date().toISOString(),
});

after(() => rmSync(DATA_DIR, { recursive: true, force: true }));

test("playpen gate: a dev host (not root) never claimed a boundary — ok", () => {
  assert.deepEqual(playpenGate(false, report(false, "not running as root (dev host)")), { ok: true });
});

test("playpen gate: a root machine with the boundary enforced — ok", () => {
  assert.deepEqual(playpenGate(true, report(true)), { ok: true });
});

test("playpen gate: a root machine whose enforcement failed — refused, reason surfaced", () => {
  const verdict = playpenGate(true, report(false, "log/events.jsonl: EPERM"));
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /EPERM/);
});

test("snapshot: a clean workspace archive passes", () => {
  writeFileSync(join(DATA_DIR, "note.txt"), "just context\n");
  assert.deepEqual(checkSnapshotHygiene(createArchive(true).body), { ok: true });
});

test("snapshot: the browser profile refuses (the full/shelf variant must never ride the escrow)", () => {
  mkdirSync(join(DATA_DIR, "browser", "Default"), { recursive: true });
  writeFileSync(join(DATA_DIR, "browser", "Default", "Cookies"), "session bearer tokens");
  try {
    const verdict = checkSnapshotHygiene(createArchive(false).body);
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /browser profile in snapshot: browser\//); // first member = the dir entry
    // The escrow variant excludes it by construction — and the gate verifies.
    assert.deepEqual(checkSnapshotHygiene(createArchive(true).body), { ok: true });
  } finally {
    rmSync(join(DATA_DIR, "browser"), { recursive: true, force: true });
  }
});

test("snapshot: a registered secret in a workspace file refuses, naming the file", () => {
  const VALUE = "sk-live-0123456789abcdef";
  registerSecret("test-inference-key", VALUE);
  try {
    mkdirSync(join(DATA_DIR, "workspace"), { recursive: true });
    writeFileSync(join(DATA_DIR, "workspace", "leak.txt"), `key = ${VALUE}\n`);
    const verdict = checkSnapshotHygiene(createArchive(true).body);
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /"test-inference-key" in snapshot at workspace\/leak\.txt/);
  } finally {
    unregisterSecret("test-inference-key");
    rmSync(join(DATA_DIR, "workspace"), { recursive: true, force: true });
  }
});

test("snapshot: arm-time extras scan too (the dev arm's inference key)", () => {
  const VALUE = "dev-arm-key-9876543210fedcba";
  mkdirSync(join(DATA_DIR, "workspace"), { recursive: true });
  writeFileSync(join(DATA_DIR, "workspace", "k.txt"), VALUE);
  try {
    assert.equal(checkSnapshotHygiene(createArchive(true).body).ok, true); // not in the registry
    const verdict = checkSnapshotHygiene(createArchive(true).body, [["arm-inference-key", VALUE]]);
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /"arm-inference-key" in snapshot at workspace\/k\.txt/);
  } finally {
    rmSync(join(DATA_DIR, "workspace"), { recursive: true, force: true });
  }
});

test("snapshot: a long path under browser/ still refuses (GNU longname / pax headers)", () => {
  mkdirSync(join(DATA_DIR, "browser", "Default"), { recursive: true });
  const deep = join(DATA_DIR, "browser", "Default", `${"l".repeat(140)}.txt`);
  writeFileSync(deep, "x");
  try {
    const body = createArchive(false).body;
    // The walker itself must resolve the >100-char member name — GNU
    // longname ('L') members on Linux carry the full name; macOS bsdtar
    // truncates the header name at 100 bytes, but the leading components
    // ("browser/Default/") survive — which is what the browser check
    // matches on. Both dialects must surface the long member.
    const names = walkTar(decodeArchive(body)).map((m) => m.name);
    assert.ok(names.some((n) => /^browser\/Default\/l+/.test(n)), `long member resolved: ${names.join(",")}`);
    const verdict = checkSnapshotHygiene(body);
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /browser profile in snapshot: browser\//);
  } finally {
    rmSync(join(DATA_DIR, "browser"), { recursive: true, force: true });
  }
});

test("snapshot: a secret in a member NAME refuses (header hit, no content range)", () => {
  const VALUE = "hdr-secret-456789abcdef0123";
  registerSecret("test-header-secret", VALUE);
  try {
    mkdirSync(join(DATA_DIR, "workspace", VALUE), { recursive: true });
    writeFileSync(join(DATA_DIR, "workspace", VALUE, "innocent.txt"), "clean");
    const verdict = checkSnapshotHygiene(createArchive(true).body);
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /"test-header-secret" in snapshot in a tar path\/header/);
  } finally {
    unregisterSecret("test-header-secret");
    rmSync(join(DATA_DIR, "workspace"), { recursive: true, force: true });
  }
});

test("snapshot: an undecodable body throws (the sleep gate's catch degrades it)", () => {
  assert.throws(() => checkSnapshotHygiene(Buffer.from("not a tarball at all")));
});
