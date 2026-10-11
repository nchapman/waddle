import { it } from "node:test";
import assert from "node:assert/strict";

/** The sentinel contract, on a PRISTINE module (no adoption ran here):
 *  an identity-less machine must never write concierge rows — a
 *  mis-keyed row fires against nothing (the concierge's namespace gates
 *  403 the sentinel; this guard makes the machine honest BEFORE the
 *  network agrees). Observable: a session is minted WITHOUT an
 *  instance (secret-tier handshake that teaches nothing), so the
 *  write path is fully live — only the UNADOPTED guard stands between
 *  renewIdleStop() and the wire. */
process.env.CONCIERGE_URL = process.env.CONCIERGE_URL ?? "https://concierge.test";
const { handshakeConcierge, currentInstance, renewIdleStop } = await import("./concierge.js");

it("an unadopted machine never writes rows — renewIdleStop is a no-op even with a live session", async () => {
  // 1. Mint a session that teaches NO instance → identity stays sentinel.
  const originalFetch = globalThis.fetch;
  let writeAttempted = false;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/handshake")) {
      return { ok: true, status: 200, json: async () => ({ session_token: "t" }) } as Response;
    }
    writeAttempted = true;
    throw new Error("MUST NOT WRITE while unadopted");
  }) as typeof fetch;
  try {
    const ok = await handshakeConcierge("secret");
    assert.equal(ok, true, "session minted");
    assert.equal(currentInstance(), "unadopted", "handshake taught no identity");
    // 2. The guard must prevent the wire call — the session is live, so
    //    only INSTANCE === UNADOPTED stands in the way.
    renewIdleStop();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(writeAttempted, false, "no concierge call may leave an identity-less machine");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
