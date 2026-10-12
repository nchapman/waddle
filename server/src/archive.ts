/**
 * The whole-machine backup: one zstd'd tarball of the enclave's working
 * directory — sealed log, pi session transcripts, workspace files, the
 * Chromium profile (logins ride with it). bb-backup.ts owns the shelf
 * lifecycle: it packs via createArchive() on its periodic/self-shelving
 * ticks and restores via restoreArchive() before a fresh boot's unlock.
 * Nothing here ever opens the archive; callers treat it as opaque bytes.
 *
 * Regenerable churn (browser caches, singleton locks) is excluded — the
 * archive is state, not disk.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { DATA_DIR } from "./state.js";
import { enforcePlaypen } from "./guard/playpen.js";

const EXCLUDES = [
  // The wake credential is machine-local by design: it must never ride
  // the shelf — the sealed log and transcripts already travel there, and
  // this file is the one plaintext key material DATA_DIR ever holds.
  "wake-credential.json",
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
      // mtime is hashed at whole-second precision: that's what tar round-
      // trips. GNU tar (the production enclave, and CI) stores seconds —
      // hashing ms meant every restored tree "changed" and the gate
      // re-pushed a spurious generation after each restore (caught by CI
      // on ubuntu; macOS bsdtar preserves ns, masking it locally).
      else h.update(`${childRel}:${st.size}:${Math.floor(st.mtimeMs / 1000)};`);
    }
  };
  walk(DATA_DIR, ".");
  return h.digest("hex");
}

/** Pack the working directory into one zstd'd tarball.
 *  `withoutBrowser`: the escrow-snapshot variant — excludes the browser
 *  profile entirely. The wake snapshot exists to give an unattended boot
 *  its CONTEXT (log, verifier, workspace, schedules); the profile is
 *  tens of MiB of lived-in state that would blow the arm body limit, and
 *  attended restores still get it via the shelf. Bounded beats blank. */
export function createArchive(withoutBrowser = false): Archive {
  // Plain tar (no compression flags — tar's zstd support varies by
  // build), piped through the zstd CLI. One retry: files can vanish
  // between listing and read (Chromium singleton churn); a second pass
  // over the survivors is stable.
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = spawnSync(
      "tar",
      [
        "-cf",
        "-",
        ...(withoutBrowser ? [...EXCLUDES, "browser"] : EXCLUDES).flatMap((e) => ["--exclude", e]),
        "-C",
        DATA_DIR,
        ".",
      ],
      { maxBuffer: 1 << 30 },
    );
    const res =
      raw.status === 0 && raw.stdout
        ? spawnSync("zstd", ["-q", "-3", "-"], { input: raw.stdout, maxBuffer: 1 << 30 })
        : raw;
    if (res.status === 0 && res.stdout) {
      return { body: res.stdout, size: res.stdout.length };
    }
    if (attempt === 1) {
      throw new Error(`archive: tar exited ${res.status}: ${res.stderr?.toString().slice(0, 400)}`);
    }
  }
  throw new Error("archive: unreachable");
}

/** Decode the zstd'd tar body (the pack path's mirror). Throws on a
 *  non-zstd body. (The decoded tar goes through a temp FILE downstream,
 *  not stdin — macOS bsdtar cannot pipe through stdin reliably.) Exported
 *  for guard/arm.ts, whose hygiene checks read the member list and scan
 *  for secret values BEFORE the snapshot is sealed and escrowed. */
export function decodeArchive(body: Buffer): Buffer {
  // Slots are zstd'd tar — the pack path's mirror. The body goes
  // through a temp FILE, not stdin — macOS bsdtar cannot pipe through
  // stdin reliably.
  const zstd = body.length > 4 && body[0] === 0x28 && body[1] === 0xb5 && body[2] === 0x2f && body[3] === 0xfd;
  if (!zstd) throw new Error("restore: not a valid zstd tarball");
  const dec = spawnSync("zstd", ["-dcq", "-"], { input: body, maxBuffer: 1 << 30 });
  if (dec.status !== 0 || !dec.stdout) {
    throw new Error(`restore: zstd decode failed: ${dec.stderr?.toString().slice(0, 200)}`);
  }
  return dec.stdout;
}

/** Validate + restore an archive into the working directory, replacing
 *  what is there (callers restore only onto a fresh enclave — the wipe is
 *  the point: the machine comes back exactly as it went down). */
export function restoreArchive(body: Buffer): { files: number } {
  // The slot lands in DATA_DIR, never os.tmpdir(): tinfoil mounts /tmp
  // read-only, and a restore that can't stage its slot dies with EROFS
  // (docker/compose never catches this — /tmp is writable there).
  const tmpRoot = join(DATA_DIR, "tmp");
  mkdirSync(tmpRoot, { recursive: true });
  const slotPath = join(tmpRoot, `waddle-slot-${process.pid}-${Date.now()}`);
  try {
    // Inside the try: a failed/partial write must never leak a partial
    // tarball onto the persistent volume.
    writeFileSync(slotPath, decodeArchive(body));
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
  // The archive carries whatever ownership it was packed with — re-assert
  // the playpen: agent workspace, browser profile, sticky tmp, root-only
  // system tree. No restore, however old or hostile, widens the boundary.
  // Re-assert the boundary over everything the archive just moved in —
  // a hostile snapshot is exactly the place a symlinked system entry
  // would come from. Deliberately not fatal: enforcePlaypen() has already
  // moved entries in place by the time it reports, so throwing here would
  // neither un-restore nor help — the report is live in /health (the call
  // above updates it), and the arm-hygiene gate (slice 4) refuses to
  // escrow secrets from a machine whose playpen isn't enforced.
  enforcePlaypen();
  return { files: names.filter((n) => !n.endsWith("/")).length };
}
