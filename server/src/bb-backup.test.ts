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

// A tiny in-memory betterbase files server mimicking the real semantics
// (sync bf55fe7): PUTs are create-only — different bytes under a live id
// → 409, byte-identical retries → idempotent 204; DELETE tombstones the
// id (GET/HEAD then 404, re-upload resurrects); HEAD probes existence.
const shelf = new Map<string, { body: Uint8Array; wrapped: string; deleted?: boolean }>();
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
  const u = url.toString();
  const id = u.split("/files/")[1] ?? "";
  if (init?.method === "PUT") {
    const hit = shelf.get(id);
    if (hit && !hit.deleted) {
      const incoming = new Uint8Array(await new Response(init.body).arrayBuffer());
      if (Buffer.compare(Buffer.from(incoming), Buffer.from(hit.body)) === 0) {
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({ error: "file already exists with different content — use a new file id" }), { status: 409 });
    }
    shelf.set(id, {
      body: new Uint8Array(await new Response(init.body).arrayBuffer()),
      wrapped: String((init.headers as Record<string, string>)["X-Wrapped-DEK"]),
    });
    return new Response(null, { status: 201 });
  }
  if (init?.method === "DELETE") {
    const hit = shelf.get(id);
    if (!hit || hit.deleted) return new Response(null, { status: 404 });
    hit.deleted = true;
    return new Response(null, { status: 204 });
  }
  if (init?.method === "HEAD") {
    const hit = shelf.get(id);
    return new Response(null, { status: hit && !hit.deleted ? 200 : 404 });
  }
  const hit = shelf.get(id);
  if (!hit || hit.deleted) return new Response(null, { status: 404 });
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
  // are immutable — rewriting the same id would be a silent no-op). No
  // bulk needed: the event log alone is the gate, so even a machine that
  // gzips to a few KiB shelves (the old size heuristic would have
  // mistaken it for a failed-restore boot).
  writeFileSync(join(dir, "log", "events.jsonl"), "sealed\nmore\n");
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
  // tar preserves mtimes on extract, so the restored tree fingerprints
  // identically to what was pushed — the gate correctly skips.
  const r4 = await bb.pushMachineBackup();
  assert.equal(r4.pushed, false);
  assert.equal(r4.gen, 1);
});

test("a log-less machine never becomes latest on a populated shelf", async () => {
  const secret = Buffer.from(webcrypto.getRandomValues(new Uint8Array(64))).toString("base64");
  const space = "77777777-8888-9999-0000-111111111111";
  await bb.setBbGrant(secret, { ...(await clientGrant(secret)), spaceId: space });
  mkdirSync(join(dir, "log"), { recursive: true });
  writeFileSync(join(dir, "log", "events.jsonl"), "history\n");
  const r1 = await bb.pushMachineBackup();
  assert.equal(r1.pushed, true);
  assert.equal(r1.gen, 0);

  // Failed-restore boot: the volume came back empty (log gone), the
  // fingerprint changed, but the shelf still holds real state — pushing
  // would make an empty generation "latest" and starve the next cold
  // boot of its history.
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const r2 = await bb.pushMachineBackup();
  assert.equal(r2.pushed, false);

  // A virgin machine on an EMPTY shelf still shelves itself — someone
  // has to create gen 0.
  const fresh = "aaaaaaa2-bbbb-cccc-dddd-eeeeeeeeeeee";
  await bb.setBbGrant(secret, { ...(await clientGrant(secret)), spaceId: fresh });
  const r3 = await bb.pushMachineBackup();
  assert.equal(r3.pushed, true);
  assert.equal(r3.gen, 0);
});

test("pruning keeps the manifest log and kills only old slots; restore walks down", async () => {
  const secret = Buffer.from(webcrypto.getRandomValues(new Uint8Array(64))).toString("base64");
  const space = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  await bb.setBbGrant(secret, { ...(await clientGrant(secret)), spaceId: space });
  mkdirSync(join(dir, "log"), { recursive: true });
  writeFileSync(join(dir, "log", "events.jsonl"), "v0\n");
  const noise = (n: number) => {
    mkdirSync(join(dir, "workspace"), { recursive: true });
    const b = new Uint8Array(1 << 17);
    for (let i = 0; i < b.length; i += 65536) {
      webcrypto.getRandomValues(b.subarray(i, Math.min(i + 65536, b.length)));
    }
    b[0] = n; // per-generation variation
    writeFileSync(join(dir, "workspace", "state.bin"), b);
  };
  // Four generations: after gen 3 lands, gen 0's slot is pruned (log stays).
  for (let gen = 0; gen <= 3; gen++) {
    writeFileSync(join(dir, "log", "events.jsonl"), `v${gen}\n`);
    noise(gen);
    const r = await bb.pushMachineBackup();
    assert.equal(r.gen, gen);
    await bb.pruneOldGens(gen); // deterministic in the test (fire-and-forget in prod)
  }
  // The manifest log is anchored and contiguous; only old slots die.
  assert.ok(shelf.get(bb.shelfManifestId(space, 0)) && !shelf.get(bb.shelfManifestId(space, 0))!.deleted, "gen 0 manifest live");
  const deletedIds = [...shelf.entries()].filter(([, v]) => v.deleted).map(([k]) => k);
  assert.equal(deletedIds.length, 1, "exactly gen 0's slot is tombstoned");
  assert.ok(!shelf.get(bb.shelfManifestId(space, 3))!.deleted, "gen 3 manifest live");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const restored = await bb.pullMachineBackup();
  assert.ok(restored);
  assert.equal(restored.gen, 3);
  assert.equal(readFileSync(join(dir, "log", "events.jsonl"), "utf8"), "v3\n");
});

test("manifest conflict (409) heals by re-probing the shelf generation", async () => {
  const secret = Buffer.from(webcrypto.getRandomValues(new Uint8Array(64))).toString("base64");
  const space = "11111111-2222-3333-4444-555566667777";
  await bb.setBbGrant(secret, { ...(await clientGrant(secret)), spaceId: space });
  mkdirSync(join(dir, "log"), { recursive: true });
  writeFileSync(join(dir, "log", "events.jsonl"), "gen0\n");
  const noise = new Uint8Array(1 << 17);
  for (let i = 0; i < noise.length; i += 65536) {
    webcrypto.getRandomValues(noise.subarray(i, Math.min(i + 65536, noise.length)));
  }
  mkdirSync(join(dir, "workspace"), { recursive: true });
  writeFileSync(join(dir, "workspace", "state.bin"), noise);
  await bb.pushMachineBackup(); // gen 0
  // Simulate divergence: the shelf already holds a gen-1 manifest our
  // counter doesn't know about (a half-landed push from a previous life).
  shelf.set(bb.shelfManifestId(space, 1), {
    body: new Uint8Array(Buffer.from("stranger-bytes")),
    wrapped: Buffer.from("w".repeat(44)).toString("base64"),
  });
  writeFileSync(join(dir, "log", "events.jsonl"), "gen0\nchanged\n");
  writeFileSync(join(dir, "workspace", "state.bin"), noise.subarray(0, (1 << 17) - 1));
  const r = await bb.pushMachineBackup();
  // The 409 is caught, the shelf is re-probed (latest = 1), and the push
  // lands as gen 2 instead of silently clobbering or looping.
  assert.equal(r.pushed, true);
  assert.equal(r.gen, 2);
  assert.ok(shelf.has(bb.shelfManifestId(space, 2)));
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
  // Re-arm with the wrong secret: every generation's manifest fails to
  // open (DEKs wrapped under the owner's key) — the walk-down treats them
  // as unreadable and the pull restores nothing. Another secret's machine
  // stays shut: no rejection, no bytes, no leak.
  await bb.setBbGrant(other, await clientGrant(other));
  assert.equal(await bb.pullMachineBackup(), null);
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
