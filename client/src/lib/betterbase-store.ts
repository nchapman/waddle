/**
 * The user's store: betterbase account sync for waddle.
 *
 * The browser — never the enclave runtime — holds the betterbase session;
 * the ENCLAVE holds its own shelf credentials after unlock (see
 * bb-grant.ts). This module only opens the account-scoped database (auth
 * machinery + the file-upload anchor record). No data records: machine
 * backups are files.
 */
import { createDatabase, type Database } from "betterbase/db";
import { FileStore, lazyWorkerFileStorage } from "betterbase/sync";
import { machines } from "./bb-collections.js";
import { machineAnchorId } from "./bb-grant.js";

// v3: records are out of the data path entirely (files only). v1's single
// snapshot record carried a 4.2MB text blob whose CRDT re-merge wedged the
// worker (betterbase#7); v2 was the record→file transition.
const DB_BASE = "waddle3";

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
  const db = await createDatabase(dbName, [machines], { worker: createDbWorker() });
  const fileStore = new FileStore({
    storage: lazyWorkerFileStorage(`files-${dbName}`, { worker: createFilesWorker() }),
  });
  return { db, fileStore, dbName };
}

/** Ensure the file-upload anchor record exists (created once, never updated).
 *  Per-space id — see machineAnchorId for why it must never be a constant. */
export async function ensureMachineAnchor(store: AccountStore, spaceId: string): Promise<void> {
  try {
    const anchorId = await machineAnchorId(spaceId);
    const existing = await store.db.get(machines, anchorId);
    if (existing) return;
    await store.db.put(machines, { id: anchorId, label: "waddle machine" });
  } catch (e) {
    console.warn("machine anchor ensure failed", e);
  }
}
