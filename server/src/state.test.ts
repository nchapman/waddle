import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// DATA_DIR is read at module load — point it at a scratch dir FIRST.
// (node --test runs each file in its own process: no cross-file bleed.)
const dir = mkdtempSync(join(tmpdir(), "waddle-lock-test-"));
process.env.DATA_DIR = dir;

const { Lock } = await import("./state.js");
const MASTER = Buffer.alloc(64, 7).toString("base64");

describe("Lock (master path, two-tier)", () => {
  it("enrolls TOFU then verifies; verifier is deterministic (same secret re-enrolls identically)", () => {
    const lock = new Lock();
    const a = lock.unlock(MASTER, "n1");
    const before = readFileSync(join(dir, "verifier.bin"));
    const b = lock.unlock(MASTER, "n2");
    const after = readFileSync(join(dir, "verifier.bin"));
    assert.ok(lock.verify(a.token));
    assert.ok(lock.verify(b.token));
    assert.ok(before.equals(after), "same secret → same verifier (a snapshot-restored boot unlocks verified)");
  });

  it("wrong secret on an enrolled machine 401s (the autonomous boot inherits this via the restored snapshot)", () => {
    const lock = new Lock();
    lock.unlock(MASTER, "n1");
    assert.throws(() => lock.unlock(Buffer.alloc(64, 9).toString("base64"), "n2"), /wrong secret/i);
  });


  it("resyncEnrollment makes a snapshot-restored boot VERIFY, not TOFU-enroll", () => {
    // The autonomous boot sequence: Lock constructed on a fresh volume
    // (enrolled=false), then restoreArchive brings verifier.bin in, then
    // resyncEnrollment + unlock. A WRONG secret must 401 — without the
    // resync the boot would silently enroll the credential's secret.
    const first = new Lock();
    first.unlock(MASTER, "boot-a"); // enrolls the real verifier
    const verifier = readFileSync(join(dir, "verifier.bin"));
    rmSync(dir, { recursive: true, force: true }); // fresh deploy volume
    const restored = new Lock(); // constructed BEFORE the restore lands
    assert.equal(restored.enrolled, false, "fresh volume: nothing enrolled yet");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "verifier.bin"), verifier); // the snapshot restore
    restored.resyncEnrollment();
    assert.equal(restored.enrolled, true, "restored verifier recognized");
    const wrong = Buffer.alloc(64, 0x5a).toString("base64");
    assert.throws(() => restored.unlock(wrong, "boot-b"), /wrong secret/);
    assert.ok(restored.unlock(MASTER, "boot-c").token, "right secret still unlocks");
  });

  it("rate-limits brute-force attempts", () => {
    const fresh = new Lock();
    fresh.unlock(MASTER, "c1"); // enroll (counts as 1 attempt)
    const wrong = Buffer.alloc(64, 3).toString("base64");
    for (let i = 0; i < 6; i++) {
      try {
        fresh.unlock(wrong, `w${i}`);
      } catch {
        /* the 429s we're counting */
      }
    }
    assert.throws(() => fresh.unlock(wrong, "w9"), /too many/);
  });

  it("cleans up scratch DATA_DIR", () => {
    rmSync(dir, { recursive: true, force: true });
  });
});
