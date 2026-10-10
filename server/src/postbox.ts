/**
 * Postbox — return mail for unattended runs.
 *
 * The autonomous machine cannot push its transcript to the user's shelf
 * (that path needs a betterbase grant only a client unlock supplies), so
 * at re-sleep it seals what it did and drops the blob on the concierge.
 * Sealing key: HKDF(autonomyKey, "postbox") — the autonomy subkey is
 * derived from the master at every unlock, so any future unlock can open
 * the mail; nobody else can (the concierge included — it holds ciphertext).
 *
 * The payload carries the run's events AND the schedule table (with
 * done-markers): merging the table is what stops the next unlock from
 * re-firing a schedule the unattended run already completed.
 */
import { derive, seal, open } from "./keys.js";
import type { Schedule } from "./schedules.js";

/** The schedule-scoped key escrowed with the concierge: never the master. */
export function autonomyKeyFromSecret(secretB64: string): string {
  return derive(Buffer.from(secretB64, "base64"), "autonomy").toString("base64");
}

export interface PostboxPayload {
  /** The autonomous session's event log (boot marker → run output). */
  events: Array<Record<string, unknown>>;
  /** The full schedule table as the run left it (done-markers set). */
  schedules: Schedule[];
}

const AAD = (instance: string) => `waddle-postbox-v1:${instance}`;

export function sealPostbox(autonomyKeyB64: string, instance: string, payload: PostboxPayload): string {
  const key = derive(Buffer.from(autonomyKeyB64, "base64"), "postbox");
  return seal(key, Buffer.from(JSON.stringify(payload)), AAD(instance)).toString("base64");
}

/** Throws on wrong key / tampered blob / wrong instance — callers warn and
 *  drop; mail is already consumed by the pull. */
export function openPostbox(autonomyKeyB64: string, instance: string, blobB64: string): PostboxPayload {
  const key = derive(Buffer.from(autonomyKeyB64, "base64"), "postbox");
  return JSON.parse(open(key, Buffer.from(blobB64, "base64"), AAD(instance)).toString()) as PostboxPayload;
}

/** Merge schedule tables as an id-UNION: postbox rows are newer truth
 *  (done-markers, realignments) and replace by id; postbox-only rows —
 *  schedules the unattended run CREATED (agent chaining) — are added;
 *  local rows not mentioned survive untouched. (A replace-only merge
 *  dropped chained creations and resurrected unattended cancellations.) */
export function mergeSchedules(local: Schedule[], postbox: Schedule[]): Schedule[] {
  const byId = new Map(local.map((s) => [s.id, s]));
  for (const s of postbox) byId.set(s.id, s); // postbox wins per id
  return [...byId.values()];
}

/** Rows worth escrowing: enabled schedules only, serialized plainly — the
 *  credential carries exactly the work the boot must be able to run. */
export function schedulableRows(schedules: Schedule[]): Array<Record<string, unknown>> {
  return schedules.filter((s) => s.enabled).map((s) => ({ ...s }));
}
