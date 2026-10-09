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
import { mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { DATA_DIR } from "./state.js";

const EXCLUDES = [
  "browser/*/Cache",
  "browser/*/Code Cache",
  "browser/*/GPUCache",
  "browser/*/GPUPersistentCache",
  "browser/*/DawnWebGPUCache",
  "browser/*/DawnGraphiteCache",
  "browser/*/GraphiteDawnCache",
  "browser/*/ShaderCache",
  "browser/*/Media Cache",
  "browser/*/Service Worker/CacheStorage",
  "browser/*/Service Worker/ScriptCache",
  "browser/*/blob_storage",
  "browser/*/Sessions",
  "browser/*/Session Storage",
  "browser/Singleton*",
  // Chromium component updater payloads (TTS engine, omnibox suggest
  // model, CRL sets, safety lists, hyphenation, spellcheck dicts, …).
  // Measured at ~80 MiB raw on a lived-in profile — 96% of a 34 MiB slot —
  // and none of it is user state: the agent browser runs fine without
  // them and re-downloads what it needs.
  "browser/component_crx_cache",
  "browser/WasmTtsEngine",
  "browser/OnDeviceHeadSuggestModel",
  "browser/ActorSafetyLists",
  "browser/hyphen-data",
  "browser/ZxcvbnData",
  "browser/CertificateRevocation",
  "browser/OptimizationHints",
  "browser/OptimizationGuideModelsManifest",
  "browser/OptimizationGuidePredictionModels",
  "browser/Dictionaries",
  "browser/Subresource Filter",
  "browser/Crashpad",
  // Telemetry + predictor scratch: histograms, UKM, omnibox predictor,
  // compression dictionaries, first-party sets. Regenerated on use.
  "browser/*/BrowserMetrics*",
  "browser/BrowserMetrics*",
  "browser/*/segmentation_platform",
  "browser/segmentation_platform",
  "browser/*/Network Action Predictor",
  "browser/*/Shared Dictionary",
  "browser/*/Reporting and NEL",
  "browser/first_party_sets.db",
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
 *  Tar/zstd bytes are not reproducible (embedded timestamps), so the push
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

/** Pack the working directory into one zstd'd tarball. */
export function createArchive(): Archive {
  // Plain tar (no compression flags — tar's zstd support varies by
  // build), piped through the zstd CLI. One retry: files can vanish
  // between listing and read (Chromium singleton churn); a second pass
  // over the survivors is stable.
  for (let attempt = 0; ; attempt++) {
    const raw = spawnSync(
      "tar",
      ["-cf", "-", ...EXCLUDES.flatMap((e) => ["--exclude", e]), "-C", DATA_DIR, "."],
      { maxBuffer: 1 << 30 },
    );
    const res =
      raw.status === 0 && raw.stdout
        ? spawnSync("zstd", ["-q", "-3", "-"], { input: raw.stdout, maxBuffer: 1 << 30 })
        : raw;
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
/** Slots are zstd'd tar — the pack path's mirror. The body goes
 * through a temp FILE, not stdin — macOS bsdtar cannot pipe through
 * stdin reliably. */
function detarBody(body: Buffer): Buffer {
  const zstd = body.length > 4 && body[0] === 0x28 && body[1] === 0xb5 && body[2] === 0x2f && body[3] === 0xfd;
  if (!zstd) throw new Error("restore: not a valid zstd tarball");
  const dec = spawnSync("zstd", ["-dcq", "-"], { input: body, maxBuffer: 1 << 30 });
  if (dec.status !== 0 || !dec.stdout) {
    throw new Error(`restore: zstd decode failed: ${dec.stderr?.toString().slice(0, 200)}`);
  }
  return dec.stdout;
}

export function restoreArchive(body: Buffer): { files: number } {
  // The slot lands in DATA_DIR, never os.tmpdir(): tinfoil mounts /tmp
  // read-only, and a restore that can't stage its slot dies with EROFS
  // (docker/compose never catches this — /tmp is writable there).
  const tmpRoot = join(DATA_DIR, "tmp");
  mkdirSync(tmpRoot, { recursive: true });
  const slotPath = join(tmpRoot, `waddle-slot-${process.pid}-${Date.now()}`);
  writeFileSync(slotPath, detarBody(body));
  try {
    return restoreFrom(slotPath);
  } finally {
    rmSync(slotPath, { force: true });
  }
}

function restoreFrom(slotPath: string): { files: number } {
  const list = spawnSync("tar", ["-tf", slotPath], { maxBuffer: 1 << 28 });
  if (list.status !== 0 || !list.stdout) {
    throw new Error("restore: not a valid tarball");
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
    const untar = spawnSync("tar", ["-xf", slotPath, "-C", staging], {
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
