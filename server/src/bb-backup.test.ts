import { test } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const subtle = webcrypto.subtle;

// Scratch working dir for archive.ts (read at module load).
const dir = mkdtempSync(join(tmpdir(), "waddle-bb-"));
process.env.DATA_DIR = dir;
const bb = await import("./bb-backup.js");
type BbGrant = import("./bb-backup.js").BbGrant;

// A tiny in-memory betterbase files server mimicking the real semantics:
// PUTs are immutable (write-once per id — a repeat PUT is a silent no-op,
// exactly PutMode::Create), HEAD probes existence, GETs serve bytes with
// the X-Wrapped-DEK header.
const shelf = new Map<string, { body: Uint8Array; wrapped: string }>();
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
  const u = url.toString();
  const id = u.split("/files/")[1] ?? "";
  if (init?.method === "PUT") {
    if (!shelf.has(id)) {
      shelf.set(id, {
        body: new Uint8Array(await new Response(init.body).arrayBuffer()),
        wrapped: String((init.headers as Record<string, string>)["X-Wrapped-DEK"]),
      });
    }
    return new Response(null, { status: 201 });
  }
  if (init?.method === "HEAD") {
    return new Response(null, { status: shelf.has(id) ? 200 : 404 });
  }
  const hit = shelf.get(id);
  if (!hit) return new Response(null, { status: 404 });
  return new Response(hit.body as unknown as BodyInit, { status: 200, headers: { "X-Wrapped-DEK": hit.wrapped } });
}) as typeof fetch;

/** Client-side grant — pure credentials now (no key material crosses). */
async function clientGrant(secretB64: string): Promise<BbGrant> {
  void secretB64; // the secret never crosses; the enclave derives its own wrap key
  return {
    endpoint: "https://sync.test/api/v1",
    token: "test-token",
    spaceId: "0d0a2d8f-3f7e-4a6f-8a53-2f9b0c1d2e3f",
    epoch: 7,
    anchorId: "11111111-2222-3333-4444-555555555555",
  };
}

test("grant unwrap + push + pull round-trips through the files API shape", async () => {
  const secret = Buffer.from(webcrypto.getRandomValues(new Uint8Array(64))).toString("base64");
  await bb.setBbGrant(secret, await clientGrant(secret));
  assert.ok(bb.bbGrantActive());

  mkdirSync(join(dir, "log"), { recursive: true });
  writeFileSync(join(dir, "log", "events.jsonl"), "sealed\n");

  const r1 = await bb.pushMachineBackup();
  assert.equal(r1.pushed, true);
  assert.equal(r1.gen, 0);
  assert.match(r1.digest, /^[0-9a-f]{64}$/);
  // Wrapped DEK is betterbase's wire format: 44 bytes, epoch-prefixed.
  const space = "0d0a2d8f-3f7e-4a6f-8a53-2f9b0c1d2e3f";
  const m0 = shelf.get(bb.shelfManifestId(space, 0))!;
  const wrapped = Buffer.from(m0.wrapped, "base64");
  assert.equal(wrapped.length, 44);
  assert.equal(wrapped.readUInt32BE(0), 7);

  // Digest gate: unchanged machine → no re-push.
  const r2 = await bb.pushMachineBackup();
  assert.equal(r2.pushed, false);
  assert.equal(r2.gen, 0);

  // A changed machine shelves a NEW generation under a fresh id (files
  // are immutable — rewriting the same id would be a silent no-op). The
  // tree must be non-trivial: a fresh-boot machine (shelf already holding
  // real state) never clobbers "latest" with an empty generation.
  writeFileSync(join(dir, "log", "events.jsonl"), "sealed\nmore\n");
  mkdirSync(join(dir, "workspace"), { recursive: true });
  const noise = new Uint8Array(1 << 17);
  for (let i = 0; i < noise.length; i += 65536) {
    webcrypto.getRandomValues(noise.subarray(i, Math.min(i + 65536, noise.length)));
  }
  writeFileSync(join(dir, "workspace", "state.bin"), noise);
  const before = shelf.size;
  const r3 = await bb.pushMachineBackup();
  assert.equal(r3.pushed, true);
  assert.equal(r3.gen, 1);
  // Two new immutable objects landed (slot + manifest); the slot id is
  // nonce-randomized so a retried push can never collide with it.
  assert.equal(shelf.size, before + 2);
  assert.ok(shelf.has(bb.shelfManifestId(space, 1)));

  // Wipe + pull back: the NEWEST generation wins, bytes identical.
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const restored = await bb.pullMachineBackup();
  assert.ok(restored);
  assert.equal(restored.gen, 1);
  assert.equal(readFileSync(join(dir, "log", "events.jsonl"), "utf8"), "sealed\nmore\n");
  assert.equal(statSync(join(dir, "workspace", "state.bin")).size, 1 << 17);
  // tar preserves mtimes on extract, so the restored tree fingerprints
  // identically to what was pushed — the gate correctly skips.
  const r4 = await bb.pushMachineBackup();
  assert.equal(r4.pushed, false);
  assert.equal(r4.gen, 1);
});

test("a wrong secret cannot unwrap another secret's DEKs", async () => {
  const owner = Buffer.from(webcrypto.getRandomValues(new Uint8Array(64))).toString("base64");
  const other = Buffer.from(webcrypto.getRandomValues(new Uint8Array(64))).toString("base64");
  // Self-contained: shelve under the owner's secret FIRST, so there is
  // always something on this shelf for the wrong secret to fail against.
  await bb.setBbGrant(owner, await clientGrant(owner));
  mkdirSync(join(dir, "log"), { recursive: true });
  writeFileSync(join(dir, "log", "events.jsonl"), "owner-state\n");
  await bb.pushMachineBackup();
  // Re-arm with the wrong secret: pulls fail to open (DEKs wrapped under
  // the owner's derived key), so another secret's machine stays shut.
  await bb.setBbGrant(other, await clientGrant(other));
  await assert.rejects(bb.pullMachineBackup());
});

test("empty shelf pulls nothing", async () => {
  const secret = Buffer.from(webcrypto.getRandomValues(new Uint8Array(64))).toString("base64");
  await bb.setBbGrant(secret, {
    ...(await clientGrant(secret)),
    spaceId: "99999999-8888-7777-6666-555555555555", // an untouched space
  });
  assert.equal(await bb.pullMachineBackup(), null);
});

// Restore fetch for later test files in the same process.
test.after?.(() => {
  globalThis.fetch = realFetch;
});
