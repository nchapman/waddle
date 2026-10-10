/** Build-time environment — the single source for every VITE_ read. */

export const DEV = import.meta.env.VITE_DEV === "1";
export const ENCLAVE_URL =
  import.meta.env.VITE_ENCLAVE_URL ?? "https://waddle.ddg-waddle.containers.tinfoil.dev";
export const CONFIG_REPO = import.meta.env.VITE_CONFIG_REPO ?? "nchapman/waddle-config";
export const CONCIERGE_URL = import.meta.env.VITE_CONCIERGE_URL ?? "http://localhost:5390";
export const CONCIERGE_TOKEN = import.meta.env.VITE_CONCIERGE_TOKEN ?? "waddle-dev";
export const BB_DOMAIN = import.meta.env.VITE_BETTERBASE_DOMAIN ?? "localhost:5377";
export const BB_CLIENT_ID = import.meta.env.VITE_BETTERBASE_CLIENT_ID ?? "";
