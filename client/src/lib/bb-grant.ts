/**
 * The one-shot machine-shelf grant, built at unlock.
 *
 * The enclave shelves its own backups (see server/src/bb-backup.ts) — what
 * it needs from us is pure credentials: the sync Bearer token, personal
 * space id, current epoch number, and the anchor record id. No key
 * material crosses over: the epoch key never leaves the browser, and the
 * machine blob itself is sealed under the user's unlock secret on the
 * enclave side.
 */
import type { AuthSession } from "betterbase/auth";

export interface BbGrantPayload {
  endpoint: string;
  token: string;
  spaceId: string;
  epoch: number;
  anchorId: string;
}

/** The anchor record the files API requires uploads to reference —
 *  created once by ensureMachineAnchor(), never updated.
 *
 *  DERIVED PER SPACE, never a fixed constant: sync record ids are global
 *  per deployment, and a second account pushing the same fixed id gets a
 *  permanent RecordIdCollision (bad_request) — the shelf would never
 *  anchor for anyone but the first-ever user. */
export async function machineAnchorId(spaceId: string): Promise<string> {
  const h = new Uint8Array(
    await crypto.subtle.digest("SHA-1", new TextEncoder().encode(`waddle-shelf-v1:anchor:${spaceId}`)),
  );
  h[6] = ((h[6] ?? 0) & 0x0f) | 0x50; // RFC 4122 v5 shape (name-based sha1)
  h[8] = ((h[8] ?? 0) & 0x3f) | 0x80;
  const x = Array.from(h, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/** The sync base URL the enclave should push to — resolved once, cached.
 *  Dev override (VITE_BETTERBASE_SYNC_URL_ENCLAVE) points the compose
 *  enclave at the local sync service via host.docker.internal; production
 *  uses the discovered public endpoint unchanged. */
const ENDPOINT_CACHE_KEY = "waddle.bb-sync-endpoint";
let endpointPromise: Promise<string> | null = null;

export async function resolveSyncEndpoint(): Promise<string> {
  const override = import.meta.env.VITE_BETTERBASE_SYNC_URL_ENCLAVE as string | undefined;
  if (override) return override;
  if (!endpointPromise) {
    endpointPromise = (async () => {
      const cached = localStorage.getItem(ENDPOINT_CACHE_KEY);
      if (cached) return cached;
      const domain = (import.meta.env.VITE_BETTERBASE_DOMAIN as string | undefined) ?? "localhost:5377";
      const scheme = domain.endsWith(".localhost") || domain.startsWith("localhost") ? "http" : "https";
      const res = await fetch(`${scheme}://${domain}/.well-known/betterbase`);
      if (!res.ok) throw new Error(`discovery ${res.status}`);
      const meta = (await res.json()) as { syncEndpoint?: string; sync_endpoint?: string };
      const endpoint = meta.syncEndpoint ?? meta.sync_endpoint ?? "";
      if (!endpoint) throw new Error("discovery: no syncEndpoint");
      localStorage.setItem(ENDPOINT_CACHE_KEY, endpoint);
      return endpoint;
    })().catch((e) => {
      endpointPromise = null; // retry next unlock
      console.warn("bb discovery failed", e);
      return "";
    });
  }
  return endpointPromise;
}

/** Build the grant, or null when signed out / no token yet. */
export async function buildBbGrant(
  session: AuthSession | null,
  personalSpaceId: string | null,
  syncEndpoint: string,
): Promise<BbGrantPayload | null> {
  if (!session || !personalSpaceId || !syncEndpoint) return null;
  try {
    const token = await session.getToken();
    if (!token) return null;
    return {
      endpoint: syncEndpoint,
      token,
      spaceId: personalSpaceId,
      epoch: session.getEpoch() ?? 1,
      anchorId: await machineAnchorId(personalSpaceId),
    };
  } catch (e) {
    console.warn("bb grant build failed — backups disabled this session", e);
    return null;
  }
}
