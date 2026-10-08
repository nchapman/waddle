/**
 * The enclave's own shelf: whole-machine backups pushed to the user's
 * betterbase personal space — by the enclave, over its own egress.
 *
 * The running server is the source of truth; every 10 minutes, and once
 * more before the sleep gate exits the process, it tars its working
 * directory (see archive.ts), seals it under a fresh DEK, and PUTs it
 * with a wrapped-DEK header in betterbase's wire shape ([epoch:4 BE][40
 * bytes] — the sync server parses only the epoch). On a fresh boot the
 * enclave pulls the file back and restores itself before the unlock
 * response returns; the client never moves bytes.
 *
 * Keys: the DEK is wrapped under HKDF(unlock secret, "bb-dek") — the same
 * user secret that seals the event log. The machine blob is therefore
 * E2EE under the user's own secret whether or not betterbase's own file
 * crypto ever touches it (it can't — the epoch key never leaves the
 * browser, and nothing here needs it to). Credentials in the grant are
 * exactly: Bearer token, space id, epoch number, anchor record id.
 * Memory-only; never in DATA_DIR, never in the archive.
 */
import { webcrypto } from "node:crypto";
import { createHash, randomBytes } from "node:crypto";
import { derive, seal, open } from "./keys.js";
import { createArchive, restoreArchive, machineFingerprint } from "./archive.js";

const subtle = webcrypto.subtle;

export interface BbGrant {
  /** Sync base URL, enclave-reachable (e.g. https://sync.example.com/api/v1). */
  endpoint: string;
  /** Bearer token for the sync API. */
  token: string;
  /** Personal space uuid. */
  spaceId: string;
  /** Current epoch number (wrapped-DEK prefix). */
  epoch: number;
  /** Record id the files API requires uploads to reference (anchor). */
  anchorId: string;
}

// Generational slots (v2): betterbase files are immutable (PutMode::Create —
// a repeat PUT is a silent no-op), so every checkpoint goes to a FRESH
// deterministic file id derived from its generation number, and the
// manifest of that generation names the slot's id. Restore probes
// generations upward until a miss. Old generations are left in place
// (no delete route in the files API); bounded by change-gated pushes.
export const shelfSlotId = (spaceId: string, gen: number, nonce = ""): string =>
  fileUuid("slot", spaceId, `${gen}:${nonce}`);
export const shelfManifestId = (spaceId: string, gen: number): string =>
  fileUuid("manifest", spaceId, `${gen}`);

/** Deterministic name-based uuid (RFC 4122 shape, sha1-derived) so both
 *  push and pull derive the same id for a generation without any
 *  shared mutable state. */
function fileUuid(kind: string, spaceId: string, name: string): string {
  const h = createHash("sha1").update(`waddle-shelf-v1:${kind}:${spaceId}:${name}`).digest();
  h[6] = ((h[6] ?? 0) & 0x0f) | 0x50; // version 5 (name-based sha1)
  h[8] = ((h[8] ?? 0) & 0x3f) | 0x80; // RFC variant
  const hex = h.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

interface GrantState {
  grant: BbGrant;
  dekWrapKey: webcrypto.CryptoKey; // AES-KW under HKDF(secret, "bb-dek"), memory-only
  lastPushedDigest: string | null;
  /** Current shelf generation (-1 = nothing shelved yet this boot). */
  gen: number;
}

let state: GrantState | null = null;

/** b64 helpers (grant arrives as JSON). */
const b64 = (b: Uint8Array): string => Buffer.from(b).toString("base64");
const unb64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64"));

/** Arm the grant: derive the DEK-wrap key from the unlock secret, and
 *  resume the shelf's generation numbering. Files are write-once, so a
 *  counter that restarted at 0 would re-PUT ids the shelf already holds —
 *  silent no-ops that would strand every later checkpoint. A failed probe
 *  leaves gen at -1; pushes then fail loudly (network), never silently. */
export async function setBbGrant(secretB64: string, grant: BbGrant): Promise<void> {
  const wrapKeyBytes = derive(Buffer.from(secretB64, "base64"), "bb-dek");
  const dekWrapKey = await subtle.importKey("raw", wrapKeyBytes, "AES-KW", false, [
    "wrapKey",
    "unwrapKey",
  ]);
  state = { grant, dekWrapKey, lastPushedDigest: null, gen: -1 };
  try {
    state.gen = await latestShelfGen();
  } catch {
    /* unreachable sync — pushes will fail loudly until the retry path */
  }
}

export function clearBbGrant(): void {
  state = null;
}

export function bbGrantActive(): boolean {
  return state !== null;
}

/** Wrap a fresh DEK: [epoch:4 BE][AES-KW(HKDF(secret,"bb-dek"), DEK):40] —
 *  betterbase's header shape (server parses the epoch; the body is ours). */
async function wrapDek(dek: Uint8Array): Promise<Uint8Array> {
  const dekKey = await subtle.importKey("raw", dek, "AES-GCM", true, ["encrypt"]);
  const kw = new Uint8Array(await subtle.wrapKey("raw", dekKey, state!.dekWrapKey, "AES-KW"));
  const out = new Uint8Array(4 + kw.length);
  new DataView(out.buffer).setUint32(0, state!.grant.epoch, false);
  out.set(kw, 4);
  return out;
}

async function unwrapDek(wrapped: Uint8Array): Promise<Uint8Array> {
  if (wrapped.length !== 44) throw new Error(`bad wrapped DEK: ${wrapped.length} bytes`);
  const kw = wrapped.subarray(4);
  const dekKey = await subtle.unwrapKey(
    "raw",
    kw,
    state!.dekWrapKey,
    "AES-KW",
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt"],
  );
  return new Uint8Array(await subtle.exportKey("raw", dekKey));
}

/** Seal bytes under a fresh DEK and PUT them as a betterbase file. */
async function putFile(fileId: string, bytes: Buffer): Promise<void> {
  const g = state!.grant;
  const dek = new Uint8Array(randomBytes(32));
  try {
    const body = seal(Buffer.from(dek), bytes, `bb-file:${fileId}`);
    const res = await fetch(`${g.endpoint}/spaces/${g.spaceId}/files/${fileId}`, {
      method: "PUT",
      signal: AbortSignal.timeout(120_000), // body can be tens of MB
      headers: {
        Authorization: `Bearer ${g.token}`,
        "Content-Type": "application/octet-stream",
        "X-Wrapped-DEK": b64(await wrapDek(dek)),
        "X-Record-ID": g.anchorId,
      },
      body: new Uint8Array(body),
    });
    if (res.status !== 201 && res.status !== 204) {
      throw new Error(`bb put ${fileId}: ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
    }
  } finally {
    dek.fill(0);
  }
}

/** GET a betterbase file, unwrap its DEK, open the seal. */
async function getFile(fileId: string): Promise<Buffer | null> {
  const g = state!.grant;
  const res = await fetch(`${g.endpoint}/spaces/${g.spaceId}/files/${fileId}`, {
    headers: { Authorization: `Bearer ${g.token}` },
    signal: AbortSignal.timeout(120_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`bb get ${fileId}: ${res.status}`);
  const wrappedHeader = res.headers.get("X-Wrapped-DEK");
  if (!wrappedHeader) throw new Error(`bb get ${fileId}: no wrapped DEK header`);
  const dek = await unwrapDek(unb64(wrappedHeader));
  try {
    return open(Buffer.from(dek), Buffer.from(new Uint8Array(await res.arrayBuffer())), `bb-file:${fileId}`);
  } finally {
    dek.fill(0);
  }
}

/** Does this file exist? (Cheap HEAD probe for generation discovery.) */
async function headFile(fileId: string): Promise<boolean> {
  const g = state!.grant;
  const res = await fetch(`${g.endpoint}/spaces/${g.spaceId}/files/${fileId}`, {
    method: "HEAD",
    headers: { Authorization: `Bearer ${g.token}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 200) return true;
  if (res.status === 404) return false;
  throw new Error(`bb head ${fileId}: ${res.status}`);
}

export interface PushResult {
  pushed: boolean;
  gen: number;
  digest: string;
}

/** Checkpoint the machine onto the shelf (fingerprint-gated). */
export async function pushMachineBackup(
  log?: (info: Record<string, unknown>) => void,
): Promise<PushResult> {
  if (!state) throw new Error("no bb grant");
  const a = createArchive();
  const fp = machineFingerprint();
  log?.({ fp: fp.slice(0, 12), last: state.lastPushedDigest?.slice(0, 12) ?? null, size: a.size });
  if (fp === state.lastPushedDigest) return { pushed: false, gen: state.gen, digest: fp };
  // A failed restore boots a fresh, near-empty machine — shelving it would
  // make "latest" an empty generation and starve the next cold boot of the
  // real state (older gens still exist but nothing walks back to them).
  // First run (gen -1) is exempt: an empty machine must shelf itself once.
  if (state.gen >= 0 && a.size < 1 << 16) {
    return { pushed: false, gen: state.gen, digest: fp };
  }
  // Slot first, manifest second: a manifest never names a missing slot;
  // a crash between the two leaves an orphan slot, which is harmless.
  // The slot id carries a random nonce: a retry after a half-failed push
  // must not re-PUT an immutable id with different bytes (a silent no-op
  // that would strand the new digest). Only the manifest id — which the
  // discovery walk needs to be deterministic — is gen-derived.
  const gen = state.gen + 1;
  const nonce = randomBytes(8).toString("hex");
  const slotId = shelfSlotId(state.grant.spaceId, gen, nonce);
  const manifest = JSON.stringify({ gen, slotId, digest: fp, size: a.size });
  await putFile(slotId, a.body);
  await putFile(shelfManifestId(state.grant.spaceId, gen), Buffer.from(manifest));
  state.lastPushedDigest = fp;
  state.gen = gen;
  return { pushed: true, gen, digest: fp };
}

/** Pull + restore the machine from the shelf. Caller re-inits the sealed
 *  log from disk and reads the true event count. */
// Generations are contiguous (never deleted), so the latest one is the
// last hit before the first miss — a linear walk, capped for sanity.
// A single HEAD is ~1 RTT; the walk runs once per fresh boot and once
// per grant arming.
const MAX_PROBE = 4096;

/** The shelf's high-water generation (-1 = empty shelf). */
async function latestShelfGen(): Promise<number> {
  let latest = -1;
  for (let gen = 0; gen < MAX_PROBE; gen++) {
    if (!(await headFile(shelfManifestId(state!.grant.spaceId, gen)))) break;
    latest = gen;
  }
  return latest;
}

export async function pullMachineBackup(
  /** Re-checked right before the tree swap: if the machine stopped being
   *  fresh while the download ran (a late unlock raced us), the restore
   *  aborts rather than wiping a live machine out from under it. */
  stillFresh?: () => boolean,
): Promise<{ gen: number } | null> {
  if (!state) return null;
  const latest = await latestShelfGen();
  if (latest < 0) return null;
  const manifestRaw = await getFile(shelfManifestId(state.grant.spaceId, latest));
  if (!manifestRaw) return null;
  const manifest = JSON.parse(manifestRaw.toString("utf8")) as {
    gen: number;
    slotId: string;
    digest: string;
  };
  const tar = await getFile(manifest.slotId);
  if (!tar) return null;
  if (stillFresh && !stillFresh()) return null;
  restoreArchive(tar);
  state.lastPushedDigest = manifest.digest; // don't re-push what we just pulled
  state.gen = manifest.gen;
  return { gen: manifest.gen };
}
