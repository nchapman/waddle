import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// DATA_DIR is read at module load — point it at a scratch tree first.
const dir = mkdtempSync(join(tmpdir(), "waddle-archive-"));
process.env.DATA_DIR = dir;
const { createArchive, restoreArchive, machineFingerprint } = await import("./archive.js");

function seed(root: string): void {
  mkdirSync(join(root, "log"), { recursive: true });
  writeFileSync(join(root, "log", "events.jsonl"), "sealed-lines\n");
  mkdirSync(join(root, "sessions"), { recursive: true });
  writeFileSync(join(root, "sessions", "s1.jsonl"), '{"v":1}\n');
  mkdirSync(join(root, "workspace", "notes"), { recursive: true });
  writeFileSync(join(root, "workspace", "notes", "a.txt"), "user file");
  mkdirSync(join(root, "browser", "Default"), { recursive: true });
  writeFileSync(join(root, "browser", "Default", "Cookies"), "cookie-db");
  // Regenerable churn that must never ride the archive.
  mkdirSync(join(root, "browser", "Default", "Cache"), { recursive: true });
  writeFileSync(join(root, "browser", "Default", "Cache", "junk.bin"), "junk");
  mkdirSync(join(root, "home", ".cache"), { recursive: true });
  writeFileSync(join(root, "home", ".cache", "x"), "cache");
  mkdirSync(join(root, "tmp"), { recursive: true });
  writeFileSync(join(root, "tmp", "scratch"), "tmp");
}

test("escrow variant (withoutBrowser) keeps context, drops the whole profile", () => {
  seed(dir);
  const a = createArchive(true);
  const listing = spawnList(a.body);
  assert.ok(listing.some((l) => l.includes("log/events.jsonl")), "sealed log rides");
  assert.ok(listing.some((l) => l.includes("workspace/notes/a.txt")), "workspace rides");
  assert.ok(!listing.some((l) => l.includes("browser/")), "no browser bytes at all — bounded");
  // and it restores as a working DATA_DIR (browser-less by construction)
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  restoreArchive(a.body);
  assert.ok(existsSync(join(dir, "workspace", "notes", "a.txt")));
  assert.ok(!existsSync(join(dir, "browser")));
});

test("archive packs the working dir, excludes caches, restores exactly", () => {
  seed(dir);
  const a = createArchive();
  assert.ok(a.size > 0);
  // New slots are zstd (magic 28 b5 2f fd) — smaller and far faster to
  // build than the gzip slots they replace.
  assert.ok(a.body.subarray(0, 4).equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd])));

  const listing = spawnList(a.body);
  assert.ok(listing.some((l) => l.includes("log/events.jsonl")));
  assert.ok(listing.some((l) => l.includes("browser/Default/Cookies")));
  assert.ok(listing.some((l) => l.includes("workspace/notes/a.txt")));
  assert.ok(!listing.some((l) => l.includes("Cache")));
  assert.ok(!listing.some((l) => l.includes(".cache")));
  assert.ok(!listing.some((l) => l.includes("tmp/")));

  // Fresh machine: wipe the tree, restore, compare.
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const { files } = restoreArchive(a.body);
  assert.ok(files >= 4);
  assert.equal(readFileSync(join(dir, "log", "events.jsonl"), "utf8"), "sealed-lines\n");
  assert.equal(readFileSync(join(dir, "browser", "Default", "Cookies"), "utf8"), "cookie-db");
  assert.equal(readFileSync(join(dir, "workspace", "notes", "a.txt"), "utf8"), "user file");
  assert.ok(!existsSync(join(dir, "browser", "Default", "Cache")));
});

test("restore refuses archives with path traversal", () => {
  const evil = zstdTarWithEntry("../escape.txt", Buffer.from("evil"));
  assert.throws(() => restoreArchive(evil), /unsafe path/);
  const absolute = zstdTarWithEntry("/etc/passwd", Buffer.from("evil"));
  assert.throws(() => restoreArchive(absolute), /unsafe path/);
});

test("restore refuses non-tarballs", () => {
  assert.throws(() => restoreArchive(Buffer.from("not a tarball")), /not a valid/);
});



test("fingerprint ignores excluded churn — the gate tracks archived state", () => {
  seed(dir);
  const before = machineFingerprint();
  // Regenerable churn the archive never carries must not move the gate.
  writeFileSync(join(dir, "browser", "Default", "Cache", "junk2.bin"), "more junk");
  writeFileSync(join(dir, "tmp", "scratch2"), "tmp");
  writeFileSync(join(dir, "home", ".cache", "y"), "cache");
  assert.equal(machineFingerprint(), before);
  // A real state change must.
  writeFileSync(join(dir, "log", "events.jsonl"), "sealed-lines\nmore\n");
  assert.notEqual(machineFingerprint(), before);
});

function spawnList(body: Buffer): string[] {
  const dec = spawnSync("zstd", ["-dcq", "-"], { input: body, maxBuffer: 1 << 28 });
  const path = join(tmpdir(), `waddle-list-${process.pid}-${Date.now()}`);
  writeFileSync(path, dec.stdout);
  try {
    const res = spawnSync("tar", ["-tf", path], { maxBuffer: 1 << 28 });
    return res.stdout ? res.stdout.toString().split("\n") : [];
  } finally {
    rmSync(path, { force: true });
  }
}

/** Hand-build a one-entry zstd'd tar with an arbitrary (possibly hostile)
 *  entry name — the filesystem can't produce traversal names for us. */
function zstdTarWithEntry(name: string, content: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, "utf8"); // mode
  header.write("0000000\0", 108, "utf8"); // uid
  header.write("0000000\0", 116, "utf8"); // gid
  header.write(content.length.toString(8).padStart(11, "0") + "\0", 124, "utf8");
  header.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, "0")}\0`, 136, "utf8");
  header.write("        ", 148, "utf8"); // checksum placeholder (spaces)
  header.write("0", 156, "utf8"); // regular file
  let sum = 0;
  for (const b of header) sum += b;
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "utf8");
  const body = Buffer.concat([content, Buffer.alloc(512 - (content.length % 512))]);
  const tar = Buffer.concat([header, body, Buffer.alloc(1024)]);
  const res = spawnSync("zstd", ["-q", "-3", "-"], { input: tar, maxBuffer: 1 << 28 });
  if (res.status !== 0 || !res.stdout) throw new Error("zstdTarWithEntry: encode failed");
  return res.stdout;
}

/** Build a tar in-memory from [path, content] pairs. */
