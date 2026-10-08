/**
 * The whole-machine backup: one tarball of the enclave's working directory.
 *
 * The running server is the source of truth — sealed log, pi session
 * transcripts, workspace files, the Chromium profile (logins ride with it).
 * On sleep and on a periodic tick the client pulls this blob over the
 * attested channel and shelves it in the user's betterbase file storage,
 * rotating a few slots so a bad state can be rolled back. On wake it pipes
 * the newest slot back in before anything boots. The client never opens
 * the archive; it is a pipe with credentials, nothing more.
 *
 * Regenerable churn (browser caches, singleton locks) is excluded — the
 * archive is state, not disk.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { DATA_DIR } from "./state.js";

const EXCLUDES = [
  "browser/*/Cache",
  "browser/*/Code Cache",
  "browser/*/GPUCache",
  "browser/*/Media Cache",
  "browser/*/Service Worker/CacheStorage",
  "browser/*/Service Worker/ScriptCache",
  "browser/Singleton*",
  "home/.cache",
  "tmp",
].map((e) => `./${e}`);

export interface Archive {
  body: Buffer;
  /** Creation time (epoch ms) — the generation clients rotate slots by. */
  gen: number;
  digest: string;
  size: number;
}

/** Excludes as regexes over archive-relative paths (for the fingerprint walk). */
const EXCLUDE_RE = EXCLUDES.map((e) => new RegExp("^" + e.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*") + "(/|$)"));

/** Cheap change-detection: hash of every archived file's path+size+mtime.
 *  Tar/gzip bytes are not reproducible (embedded timestamps), so the push
 *  gate fingerprints the tree instead of the blob. */
export function machineFingerprint(): string {
  const h = createHash("sha256");
  // Walk paths are `./`-rooted, matching the exclude patterns (and tar's
  // member names) exactly — a mismatch here would hash regenerable churn
  // the archive never carries, defeating the change gate.
  const walk = (abs: string, rel: string): void => {
    for (const name of readdirSync(abs, { withFileTypes: true })) {
      const childRel = `${rel}/${name.name}`;
      if (EXCLUDE_RE.some((re) => re.test(childRel))) continue;
      let st;
      try {
        st = statSync(join(abs, name.name));
      } catch {
        continue; // vanished mid-walk (Chromium singleton churn) — skip
      }
      if (st.isDirectory()) walk(join(abs, name.name), childRel);
      else h.update(`${childRel}:${st.size}:${st.mtimeMs};`);
    }
  };
  walk(DATA_DIR, ".");
  return h.digest("hex");
}

/** Pack the working directory into one gzip tarball. */
export function createArchive(): Archive {
  // One retry: files can vanish between listing and read (Chromium
  // singleton churn); a second pass over the survivors is stable.
  for (let attempt = 0; ; attempt++) {
    const res = spawnSync(
      "tar",
      ["-czf", "-", ...EXCLUDES.flatMap((e) => ["--exclude", e]), "-C", DATA_DIR, "."],
      { maxBuffer: 1 << 30 },
    );
    if (res.status === 0 && res.stdout) {
      const body = res.stdout;
      return {
        body,
        gen: Date.now(),
        digest: createHash("sha256").update(body).digest("hex"),
        size: body.length,
      };
    }
    if (attempt >= 1) {
      throw new Error(`archive: tar exited ${res.status}: ${res.stderr?.toString().slice(0, 400)}`);
    }
  }
}

/**
 * Validate + restore an archive into the working directory, replacing what
 * is there. Only ever called onto a fresh enclave (the route refuses when
 * the sealed log already holds history) — the wipe is the point: the
 * machine comes back exactly as it went down.
 */
export function restoreArchive(body: Buffer): { files: number } {
  const list = spawnSync("tar", ["-tzf", "-"], { input: body, maxBuffer: 1 << 28 });
  if (list.status !== 0 || !list.stdout) {
    throw new Error("restore: not a valid gzip tarball");
  }
  const names = list.stdout.toString().split("\n").map((l) => l.trim()).filter(Boolean);
  for (const raw of names) {
    const norm = raw.replace(/^\.\//, "");
    if (norm.startsWith("/") || norm.split("/").includes("..")) {
      throw new Error(`restore: refusing unsafe path "${raw}"`);
    }
  }
  // Extract into a staging dir INSIDE the working tree — a failed untar
  // must never destroy the machine it was meant to heal, and the final
  // move must stay on the same filesystem (DATA_DIR is a mount; a sibling
  // outside it would cross devices). Old entries are only cleared after
  // a proven-good extract, then the staged entries move up.
  const staging = join(DATA_DIR, ".restore-staging");
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    const untar = spawnSync("tar", ["-xzf", "-", "-C", staging], {
      input: body,
      maxBuffer: 1 << 28,
    });
    if (untar.status !== 0) {
      throw new Error(`restore: untar exited ${untar.status}: ${untar.stderr?.toString().slice(0, 400)}`);
    }
    for (const name of readdirSync(DATA_DIR)) {
      if (name === ".restore-staging") continue;
      rmSync(join(DATA_DIR, name), { recursive: true, force: true });
    }
    for (const name of readdirSync(staging)) {
      renameSync(join(staging, name), join(DATA_DIR, name));
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return { files: names.filter((n) => !n.endsWith("/")).length };
}
