import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { sealPostbox, openPostbox, mergeSchedules, schedulableRows } from "./postbox.js";
import { derive } from "./keys.js";
import type { Schedule } from "./schedules.js";

const MASTER = randomBytes(64).toString("base64");
const OTHER = randomBytes(64).toString("base64");
const INSTANCE = "waddle";

function row(id: string, over: Partial<Schedule> = {}): Schedule {
  return { id, title: `t-${id}`, prompt: "p", enabled: true, createdAt: new Date().toISOString(), ...over };
}

describe("postbox key (master domain)", () => {
  it("seal/open take the RAW secret — the sleep-seal/unlock-open convention (review-pinned)", () => {
    // Production: index.ts seals with the raw master at re-sleep and
    // opens with the raw master at unlock. A derived key fed to either
    // side double-derives and the mail never opens — this pins that.
    const blob = sealPostbox(MASTER, INSTANCE, { events: [], schedules: [] });
    const back = openPostbox(MASTER, INSTANCE, blob);
    assert.deepEqual(back.schedules, []);
    // And the failure mode that shipped briefly: a pre-derived key must
    // NOT open a raw-secret-sealed blob.
    const derived = derive(Buffer.from(MASTER, "base64"), "waddle/postbox").toString("base64");
    assert.throws(() => openPostbox(derived, INSTANCE, blob));
  });

  it("raw-secret convention: wrong master cannot open the mail", () => {
    const blob = sealPostbox(MASTER, INSTANCE, { events: [], schedules: [] });
    assert.throws(() => openPostbox(OTHER, INSTANCE, blob));
  });
});

describe("postbox seal/open (raw-secret convention)", () => {
  it("round-trips events + schedules", () => {
    const blob = sealPostbox(MASTER, INSTANCE, {
      events: [{ type: "message", role: "assistant", text: "SIGN ok" }],
      schedules: [row("j1")],
    });
    const got = openPostbox(MASTER, INSTANCE, blob);
    assert.equal(got.events.length, 1);
    assert.equal((got.events[0] as { text?: string }).text, "SIGN ok");
    assert.equal(got.schedules[0]?.id, "j1");
  });

  it("rejects the wrong key (rotated master cannot read old mail)", () => {
    const blob = sealPostbox(MASTER, INSTANCE, { events: [], schedules: [] });
    assert.throws(() => openPostbox(OTHER, INSTANCE, blob));
  });

  it("rejects a blob posted for another instance (AAD binding)", () => {
    const blob = sealPostbox(MASTER, "waddle", { events: [], schedules: [] });
    assert.throws(() => openPostbox(MASTER, "waddle-standby-1", blob));
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
