/**
 * Postbox — return mail for unattended runs.
 *
 * The autonomous machine cannot push its transcript to the user's shelf
 * (that path needs a betterbase grant only a client unlock supplies), so
 * at re-sleep it seals what it did and drops the blob on the concierge.
 * Sealing key: HKDF(master, "waddle/postbox") — derived at every unlock,
 * so any future unlock can open the mail; nobody else can (the concierge
 * included — it holds ciphertext).
 *
 * The payload carries the run's events AND the schedule table (with
 * done-markers): merging the table is what stops the next unlock from
 * re-firing a schedule the unattended run already completed.
 */
import { derive, seal, open } from "./keys.js";
import type { Schedule } from "./schedules.js";

export interface PostboxPayload {
  /** The autonomous session's event log (boot marker → run output). */
  events: Array<Record<string, unknown>>;
  /** The full schedule table as the run left it (done-markers set). */
  schedules: Schedule[];
  /** Rows the run CANCELLED (cancel = removal, so the diff travels as
   *  tombstones: seeded-at-boot ids absent from the final table). */
  cancelledIds?: string[];
}

/** AAD v2: instance-free — a wake boot opens blobs BEFORE it can know
 *  its name (the adoption happens at the pull/handshake), so v1's
 *  instance-bound seals failed their own opens. The AEAD key derives
 *  from the master secret (the actual boundary). */
const AAD = "waddle-postbox-v2";

export function sealPostbox(secretB64: string, payload: PostboxPayload): string {
  const key = derive(Buffer.from(secretB64, "base64"), "waddle/postbox");
  return seal(key, Buffer.from(JSON.stringify(payload)), AAD).toString("base64");
}

/** Throws on wrong key / tampered blob — callers warn and drop; mail is
 *  already consumed by the pull. */
export function openPostbox(secretB64: string, blobB64: string): PostboxPayload {
  const key = derive(Buffer.from(secretB64, "base64"), "waddle/postbox");
  const plain = open(key, Buffer.from(blobB64, "base64"), AAD);
  return JSON.parse(plain.toString()) as PostboxPayload;
}

/** Merge schedule tables as an id-UNION with tombstones: postbox rows are
 *  newer truth (done-markers, realignments) and replace by id; postbox-only
 *  rows — schedules the unattended run CREATED (agent chaining) — are
 *  added; ids the run cancelled are dropped (a cancel is a removal, so it
 *  travels as an explicit tombstone list, not as an absent row). */
export function mergeSchedules(local: Schedule[], postbox: Schedule[], cancelledIds: string[] = []): Schedule[] {
  const dead = new Set(cancelledIds);
  const byId = new Map(local.map((s) => [s.id, s]));
  for (const s of postbox) byId.set(s.id, s); // postbox wins per id
  for (const id of dead) byId.delete(id);
  return [...byId.values()].filter((s) => !dead.has(s.id));
}

/** Rows worth escrowing: enabled schedules only, serialized plainly — the
 *  credential carries exactly the work the boot must be able to run. */
export function schedulableRows(schedules: Schedule[]): Array<Record<string, unknown>> {
  return schedules.filter((s) => s.enabled).map((s) => ({ ...s }));
}
