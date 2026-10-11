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

describe("EventLog (sealed per-line, one file per volume)", () => {
  before(() => {
    new EventLog(k1, "disk").append({ type: "message", text: "sealed row" });
  });

  it("re-opens under the same key and replays its rows", () => {
    const log = new EventLog(k1, "disk");
    assert.equal((log.all[0] as { text?: string }).text, "sealed row");
    assert.ok(existsSync(join(dir, "log", "events.jsonl")));
  });

  it("the wrong key never silently reads — it throws", () => {
    assert.throws(() => new EventLog(k2, "disk"));
  });

  it("memory storage appends without touching the volume", () => {
    const mem = new EventLog(k1, "memory");
    mem.append({ type: "message", text: "ephemeral" });
    assert.equal(mem.all.length, 1);
  });

  after(() => rmSync(dir, { recursive: true, force: true }));
});
