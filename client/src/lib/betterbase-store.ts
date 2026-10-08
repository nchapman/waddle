/**
 * The user's store: betterbase account sync for waddle's durable snapshot.
 *
 * Architecture (tokenless relay): the browser — never the enclave — holds
 * the betterbase session. Sealed conversation events are AEAD-encrypted
 * under HKDF(unlock secret, "backup") and checkpointed as one opaque record
 * in the user's personal space. On a fresh enclave boot the client pulls
 * the snapshot, decrypts locally, and relays the plaintext history to the
 * gateway over the attested channel (the server seals it into its log —
 * the same trust it holds for live conversation). No betterbase credential
 * ever enters the enclave, even in memory.
 */
import { createDatabase, type Database } from "betterbase/db";
import { FileStore, lazyWorkerFileStorage } from "betterbase/sync";
import { snapshots, SNAPSHOT_ID, SNAPSHOT_KEEP } from "./bb-collections.js";

// v2: "waddle2" leaves behind the v1 db whose single legacy snapshot record
// (huge, never successfully synced) wedged the worker — every put waited
// behind its interminable CRDT merge and hit the 30s RPC timeout.
const DB_BASE = "waddle2";

const createDbWorker = () =>
  new Worker(new URL("../workers/bb-db-worker.ts", import.meta.url), { type: "module" });
const createFilesWorker = () =>
  new Worker(new URL("../workers/bb-files-worker.ts", import.meta.url), { type: "module" });

/** Stable digest of the account scope (personal space id) — the DB name suffix. */
async function scopeHash(scopeKey: string): Promise<string> {
  const bytes = new TextEncoder().encode(scopeKey);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let value = 0n;
  for (let i = 0; i < 8; i++) value = (value << 8n) | BigInt(digest[i]!);
  return value.toString(36);
}

export interface AccountStore {
  db: Database;
  fileStore: FileStore;
  dbName: string;
}

/** Open the account-scoped database + file store (signed-in scope only). */
export async function openAccountStore(personalSpaceId: string): Promise<AccountStore> {
  const dbName = `${DB_BASE}_${await scopeHash(personalSpaceId)}`;
  const db = await createDatabase(dbName, [snapshots], { worker: createDbWorker() });
  const fileStore = new FileStore({
    storage: lazyWorkerFileStorage(`files-${dbName}`, { worker: createFilesWorker() }),
  });
  return { db, fileStore, dbName };
}

/** Checkpoint: append the encrypted envelope as a NEW record.
 *  Never upsert SNAPSHOT_ID — betterbase's CRDT character-merges text
 *  fields on update, and a large blob's re-merge runs tens of seconds to
 *  minutes of WASM (it pegged a worker core per tab and blew the 30s RPC
 *  timeout; fresh-id puts skip the merge entirely — ~10ms at 100KB).
 *  Old records are pruned to the newest few. */
export async function putSnapshot(store: AccountStore, blob: string, gen: number): Promise<void> {
  await store.db.put(snapshots, { id: crypto.randomUUID(), blob, gen, savedAt: Date.now() });
  await pruneSnapshots(store);
}

/** Keep the newest SNAPSHOT_KEEP records; drop the rest. */
async function pruneSnapshots(store: AccountStore): Promise<void> {
  try {
    const result = await store.db.query(snapshots, { limit: 50 });
    const rows = [...result.records].sort((a, b) => (b.gen ?? 0) - (a.gen ?? 0));
    for (const row of rows.slice(SNAPSHOT_KEEP)) {
      await store.db.delete(snapshots, row.id);
    }
  } catch {
    /* pruning is best-effort — a stale record never breaks checkpoints */
  }
}

/** Latest snapshot envelope, or null when the account has none yet. */
export async function readSnapshot(store: AccountStore): Promise<string | null> {
  const result = await store.db.query(snapshots, { limit: 50 });
  const rows = [...result.records].sort((a, b) => (b.gen ?? 0) - (a.gen ?? 0));
  for (const row of rows) {
    if (row.id === SNAPSHOT_ID) continue; // legacy single-record rows
    // Envelopes are JSON; anything else is debris from earlier probes.
    if (typeof row.blob === "string" && row.blob.startsWith("{")) return row.blob;
  }
  return null;
}
