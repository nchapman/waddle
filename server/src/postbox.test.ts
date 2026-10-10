import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { autonomyKeyFromSecret, sealPostbox, openPostbox, mergeSchedules, schedulableRows } from "./postbox.js";
import type { Schedule } from "./schedules.js";

const MASTER = randomBytes(64).toString("base64");
const INSTANCE = "waddle";

function row(id: string, over: Partial<Schedule> = {}): Schedule {
  return { id, title: `t-${id}`, prompt: "p", enabled: true, createdAt: new Date().toISOString(), ...over };
}

describe("autonomy subkey", () => {
  it("is deterministic from the master and is NOT the master", () => {
    assert.equal(autonomyKeyFromSecret(MASTER), autonomyKeyFromSecret(MASTER));
    assert.equal(autonomyKeyFromSecret(MASTER).length, 44, "32 bytes base64");
    assert.notEqual(autonomyKeyFromSecret(MASTER), MASTER);
  });

  it("differs per master (rotation revokes outstanding escrows)", () => {
    const other = randomBytes(64).toString("base64");
    assert.notEqual(autonomyKeyFromSecret(MASTER), autonomyKeyFromSecret(other));
  });
});

describe("postbox seal/open", () => {
  it("round-trips events + schedules", () => {
    const key = autonomyKeyFromSecret(MASTER);
    const blob = sealPostbox(key, INSTANCE, {
      events: [{ type: "message", role: "assistant", text: "SIGN ok" }],
      schedules: [row("j1")],
    });
    const got = openPostbox(key, INSTANCE, blob);
    assert.equal(got.events.length, 1);
    assert.equal((got.events[0] as { text?: string }).text, "SIGN ok");
    assert.equal(got.schedules[0]?.id, "j1");
  });

  it("rejects the wrong key (rotated master cannot read old mail)", () => {
    const key = autonomyKeyFromSecret(MASTER);
    const blob = sealPostbox(key, INSTANCE, { events: [], schedules: [] });
    const wrongKey = autonomyKeyFromSecret(randomBytes(64).toString("base64"));
    assert.throws(() => openPostbox(wrongKey, INSTANCE, blob));
  });

  it("rejects a blob posted for another instance (AAD binding)", () => {
    const key = autonomyKeyFromSecret(MASTER);
    const blob = sealPostbox(key, "waddle", { events: [], schedules: [] });
    assert.throws(() => openPostbox(key, "waddle-standby-1", blob));
  });
});

describe("schedule merge (the no-re-fire contract)", () => {
  it("postbox rows replace by id — done-markers win over the stale shelf copy", () => {
    const local = [row("j1"), row("j2")];
    const postbox = [row("j1", { enabled: false, lastRun: "2026-10-10T08:00:05Z" })]; // ran unattended
    const merged = mergeSchedules(local, postbox);
    assert.equal(merged.find((s) => s.id === "j1")?.enabled, false, "done-marker applied");
    assert.equal(merged.find((s) => s.id === "j2")?.enabled, true, "unmentioned rows survive");
    assert.equal(merged.length, 2);
  });

  it("tombstones drop rows the run cancelled — cancel-as-removal survives the merge", () => {
    const local = [row("j1"), row("j2"), row("j3")];
    const postboxRows = [row("j1", { enabled: false, lastRun: "2026-10-10T08:00:05Z" })]; // j2 ran+cancelled? no: j1 ran; j2 was cancelled (absent)
    const merged = mergeSchedules(local, postboxRows, ["j2", "ghost-id"]);
    assert.deepEqual(merged.map((x) => x.id).sort(), ["j1", "j3"], "cancelled id dropped, unknown tombstone harmless");
    assert.equal(merged.find((x) => x.id === "j1")?.enabled, false, "done-marker still applied");
  });

  it("schedulableRows carries enabled work only, as plain JSON", () => {
    const rows = schedulableRows([row("j1"), row("j2", { enabled: false })]);
    assert.deepEqual(rows.map((r) => r.id), ["j1"]);
    assert.equal(JSON.parse(JSON.stringify(rows)).length, 1, "serializes cleanly into the credential");
  });
});
