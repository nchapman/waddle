import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const { sealSnapshot, openSnapshot } = await import("./snapshot.js");
const { derive, seal } = await import("./keys.js");

const MASTER = randomBytes(64).toString("base64");

test("snapshot seal/open roundtrips arbitrary bytes", () => {
  const body = randomBytes(4096);
  const blob = sealSnapshot(MASTER, body);
  assert.ok(blob.length > body.length, "sealed blob carries framing");
  assert.ok(openSnapshot(MASTER, blob).equals(body));
});

test("wrong secret cannot open the snapshot", () => {
  const blob = sealSnapshot(MASTER, Buffer.from("machine state"));
  assert.throws(() => openSnapshot(randomBytes(64).toString("base64"), blob));
});

test("tampered blob is rejected (integrity, not just secrecy)", () => {
  const blob = sealSnapshot(MASTER, Buffer.from("machine state"));
  const raw = Buffer.from(blob, "base64");
  raw[raw.length - 1]! ^= 0xff;
  assert.throws(() => openSnapshot(MASTER, raw.toString("base64")));
});

test("v2 seals are instance-free — the master secret is the boundary (siblings share it)", () => {
  const blob = sealSnapshot(MASTER, Buffer.from("machine state"));
  // v1 bound the instance as AAD, but a wake boot opens its snapshot
  // before it can know its own name (adopted at pull/handshake) — v1
  // seals failed their own opens. Wrong keys still fail (test below).
  assert.equal(openSnapshot(MASTER, blob).toString(), "machine state");
  const other = randomBytes(32).toString("base64");
  assert.throws(() => openSnapshot(other, blob));
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

const LEGACY_V1_AAD = `waddle-snapshot-v1:${process.env.WADDLE_INSTANCE ?? "waddle"}`; // mirrors the module constant

test("v2 snapshot seals are instance-free; legacy v1 opens via fallback", () => {
  const MASTER = randomBytes(32).toString("base64");
  const blob = sealSnapshot(MASTER, Buffer.from("ctx"));
  assert.equal(openSnapshot(MASTER, blob).toString(), "ctx"); // baked name opener
  const key = derive(Buffer.from(MASTER, "base64"), "waddle/snapshot");
  const legacy = seal(key, Buffer.from("old"), LEGACY_V1_AAD).toString("base64");
  assert.equal(openSnapshot(MASTER, legacy).toString(), "old");
});
