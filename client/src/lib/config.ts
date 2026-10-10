/** Build-time environment — the single source for every VITE_ read.
 *  Vite injects import.meta.env; plain-node contexts (tests) get {}. */
const env = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};

export const DEV = env.VITE_DEV === "1";
export const ENCLAVE_URL = env.VITE_ENCLAVE_URL ?? "https://waddle.ddg-waddle.containers.tinfoil.dev";
export const CONFIG_REPO = env.VITE_CONFIG_REPO ?? "nchapman/waddle-config";
export const CONCIERGE_URL = env.VITE_CONCIERGE_URL ?? "http://localhost:5390";
export const CONCIERGE_TOKEN = env.VITE_CONCIERGE_TOKEN ?? "waddle-dev";
export const BB_DOMAIN = env.VITE_BETTERBASE_DOMAIN ?? "localhost:5377";
export const BB_CLIENT_ID = env.VITE_BETTERBASE_CLIENT_ID ?? "";
