import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const { sealSnapshot, openSnapshot } = await import("./snapshot.js");

const MASTER = randomBytes(64).toString("base64");
const INSTANCE = "waddle-test";

test("snapshot seal/open roundtrips arbitrary bytes", () => {
  const body = randomBytes(4096);
  const blob = sealSnapshot(MASTER, INSTANCE, body);
  assert.ok(blob.length > body.length, "sealed blob carries framing");
  assert.ok(openSnapshot(MASTER, INSTANCE, blob).equals(body));
});

test("wrong secret cannot open the snapshot", () => {
  const blob = sealSnapshot(MASTER, INSTANCE, Buffer.from("machine state"));
  assert.throws(() => openSnapshot(randomBytes(64).toString("base64"), INSTANCE, blob));
});

test("tampered blob is rejected (integrity, not just secrecy)", () => {
  const blob = sealSnapshot(MASTER, INSTANCE, Buffer.from("machine state"));
  const raw = Buffer.from(blob, "base64");
  raw[raw.length - 1]! ^= 0xff;
  assert.throws(() => openSnapshot(MASTER, INSTANCE, raw.toString("base64")));
});

test("instance is bound as AAD — cross-instance replay fails", () => {
  const blob = sealSnapshot(MASTER, INSTANCE, Buffer.from("machine state"));
  assert.throws(() => openSnapshot(MASTER, "other-instance", blob));
});

test("snapshot key domain is distinct from postbox (no cross-use)", async () => {
  // If the two domains ever collided, a leaked postbox blob would become
  // a snapshot oracle (or vice versa) — assert the labels stay separate.
  const { derive } = await import("./keys.js");
  const master = Buffer.from(MASTER, "base64");
  const snapKey = derive(master, "waddle/snapshot");
  const postboxKey = derive(master, "waddle/postbox");
  assert.notEqual(snapKey.toString("base64"), postboxKey.toString("base64"));
});
