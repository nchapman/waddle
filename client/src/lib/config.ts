/** Build-time environment — the single source for every VITE_ read.
 *  Vite injects import.meta.env; plain-node contexts (tests) get {}. */
const env = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};

export const DEV = env.VITE_DEV === "1";
export const ENCLAVE_URL = env.VITE_ENCLAVE_URL ?? "https://waddle.ddg-waddle.containers.tinfoil.dev";
export const CONFIG_REPO = env.VITE_CONFIG_REPO ?? "nchapman/waddle-config";
export const CONCIERGE_URL = env.VITE_CONCIERGE_URL ?? "http://localhost:5390";
/** The zone machines live in, derived from the concierge's own host
 *  (waddle-concierge.ddg-waddle... → ddg-waddle...) — the discovery path
 *  zone-binds handed-out URLs with it, no baked enclave URL needed.
 *  Empty in dev (localhost) — guards then refuse unbound URLs. */
export const ZONE = (() => {
  try {
    const h = new URL(CONCIERGE_URL).hostname;
    const parts = h.split(".");
    return parts.length > 2 ? parts.slice(1).join(".") : "";
  } catch {
    return "";
  }
})();
/** Concierge bearer for the wake/assign verbs. DEV-only: dev parity
 *  runs against a local concierge whose token is public by nature
 *  (compose `devsecret`). Live builds compile NOTHING — the shared
 *  secret must never ride the browser bundle; live auth is the
 *  betterbase JWT (see lib/concierge.ts). */
export const CONCIERGE_TOKEN = DEV ? (env.VITE_CONCIERGE_TOKEN ?? "devsecret") : "";
export const BB_DOMAIN = env.VITE_BETTERBASE_DOMAIN ?? "localhost:5377";
export const BB_CLIENT_ID = env.VITE_BETTERBASE_CLIENT_ID ?? "";
