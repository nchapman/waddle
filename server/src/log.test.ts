import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

// log.ts reads DATA_DIR at import — scratch dir first (own test process).
const dir = mkdtempSync(join(tmpdir(), "waddle-log-test-"));
process.env.DATA_DIR = dir;

const { EventLog } = await import("./log.js");
const k1 = randomBytes(32);
const k2 = randomBytes(32);

describe("EventLog file separation (the subkey-log invariant)", () => {
  before(() => {
    new EventLog(k1, "disk", "events.jsonl").append({ type: "message", text: "master-sealed" });
    new EventLog(k2, "disk", "events.autonomous.jsonl").append({ type: "message", text: "subkey-sealed" });
  });

  it("two key domains over one volume coexist and re-open under their own keys", () => {
    const master = new EventLog(k1, "disk", "events.jsonl");
    const auto = new EventLog(k2, "disk", "events.autonomous.jsonl");
    assert.equal((master.all[0] as { text?: string }).text, "master-sealed");
    assert.equal((auto.all[0] as { text?: string }).text, "subkey-sealed");
    assert.ok(existsSync(join(dir, "log", "events.jsonl")));
    assert.ok(existsSync(join(dir, "log", "events.autonomous.jsonl")));
  });

  it("the wrong key against a file never silently reads — it throws", () => {
    assert.throws(() => new EventLog(k2, "disk", "events.jsonl"));
  });

  after(() => rmSync(dir, { recursive: true, force: true }));
});
