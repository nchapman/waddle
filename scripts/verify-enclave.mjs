/**
 * Verify a waddle enclave the way the client will: SecureClient against
 * the container URL + config repo. Exits 0 only on verified-attestation
 * 200 from /health. Usage: node scripts/verify-enclave.mjs <container-url>
 */
import { SecureClient } from "tinfoil";

const url = process.argv[2];
if (!url) {
  console.error("usage: node scripts/verify-enclave.mjs <container-url>");
  process.exit(2);
}
const base = url.startsWith("http") ? url : `https://${url}`;

const client = new SecureClient({ enclaveURL: base, configRepo: "nchapman/waddle-config" });
await client.ready(); // throws if attestation/TLS/measurement fails

const res = await client.fetch(`${base}/health`);
const body = await res.json();
if (!res.ok || body.service !== "waddle-server") {
  console.error(`unhealthy: ${res.status}`, body);
  process.exit(1);
}
const doc = client.getVerificationDocument?.();
console.log("VERIFIED", JSON.stringify(body));
if (doc) {
  const steps = doc.steps ?? doc.attestation_steps ?? {};
  const entries = Array.isArray(steps) ? steps : Object.entries(steps);
  console.log(
    "attestation:",
    entries.map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`).join(" | "),
  );
}
