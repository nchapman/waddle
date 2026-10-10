import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// DATA_DIR is read at module load — point it at a scratch dir FIRST.
// (node --test runs each file in its own process: no cross-file bleed.)
const dir = mkdtempSync(join(tmpdir(), "waddle-lock-test-"));
process.env.DATA_DIR = dir;

const { Lock } = await import("./state.js");
const MASTER = Buffer.alloc(64, 7).toString("base64");
const SUBKEY = Buffer.alloc(32, 9).toString("base64");

describe("Lock.unlockAutonomous (the subkey path)", () => {
  const lock = new Lock();

  before(() => {
    // Enroll with the master first — the verifier file must exist so the
    // tests can prove the subkey path never touches it.
    lock.unlock(MASTER, "aaaa");
  });

  it("unlocks TOFU-style without touching the master's verifier", () => {
    const before = readFileSync(join(dir, "verifier.bin"));
    const aut = lock.unlockAutonomous(SUBKEY);
    assert.ok(aut.token, "mints a session token");
    assert.equal(aut.logKey.length, 32, "derives a log key from the subkey root");
    assert.ok(lock.verify(aut.token), "session verifies");
    const after = readFileSync(join(dir, "verifier.bin"));
    assert.ok(before.equals(after), "verifier file untouched — the subkey never clobbers enrollment");
  });

  it("the master still unlocks afterwards (enrollment survived the subkey session)", () => {
    const { token } = lock.unlock(MASTER, "bbbb");
    assert.ok(lock.verify(token));
  });

  it("rejects wrong-size keys", () => {
    assert.throws(() => lock.unlockAutonomous(Buffer.alloc(31).toString("base64")), /32 bytes/);
    assert.throws(() => lock.unlockAutonomous(MASTER), /32 bytes/); // 64-byte master is not a subkey
  });

  it("rate-limits like the user path", () => {
    const fresh = new Lock();
    fresh.unlock(MASTER, "c1"); // enroll (counts as 1 attempt)
    for (let i = 0; i < 6; i++) {
      try {
        fresh.unlockAutonomous(Buffer.alloc(32, i).toString("base64"));
      } catch {
        /* the 429s we're counting */
      }
    }
    assert.throws(() => fresh.unlockAutonomous(Buffer.alloc(32, 99).toString("base64")), /too many/);
  });

  it("cleans up scratch DATA_DIR", () => {
    rmSync(dir, { recursive: true, force: true });
  });
});
