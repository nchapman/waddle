/**
 * The external auth tier — who may talk to the concierge from outside:
 *   • a betterbase JWT (client path — per-user identity, verified against
 *     the accounts JWKS: signature + issuer + audience), or
 *   • the shared secret (machine path — the sleep gate arms escrows with
 *     it; JWKS being configured must never lock the machines out).
 * Injectable `verifyJwt` so tests pin the dual-path contract.
 */
import { createRemoteJWKSet, jwtVerify } from "jose";
import { timingSafeEqual } from "node:crypto";

export type VerifyJwt = (token: string) => Promise<unknown>;

/** WHO the bearer is, once verified: a betterbase user (JWT `sub`) or
 *  a machine (the shared secret). Null = nobody. The JWT tier without
 *  a `sub` is rejected — /boot keys machines by it. */
export type ExternalIdentity = { kind: "jwt"; sub: string } | { kind: "secret" };

/** Constant-time shared-secret compare (a straight === leaks length/prefix
 *  timing on the secret). */
export function secretOk(token: string | undefined, sharedSecret: string | undefined): boolean {
  const a = Buffer.from(token ?? "");
  const b = Buffer.from(sharedSecret ?? "");
  return !!sharedSecret && a.length === b.length && timingSafeEqual(a, b);
}

export function createVerifyExternal(opts: {
  jwksUrl?: string;
  issuer?: string;
  audience?: string;
  sharedSecret?: string;
  /** Override the JWT leg (tests); default verifies against the JWKS. */
  verifyJwt?: VerifyJwt;
}): (token: string | undefined) => Promise<ExternalIdentity | null> {
  const jwks = opts.jwksUrl ? createRemoteJWKSet(new URL(opts.jwksUrl)) : null;
// Fail fast at boot, not on the first request: an unpinned audience
// silently verifies ANY token from the issuer for ANY client. (Skipped
// only when the JWT leg is fully injected — the test seam.)
if (jwks && !opts.verifyJwt && !opts.audience) {
  throw new Error("CONCIERGE_JWKS_URL set but CONCIERGE_AUDIENCE is empty — refusing to start (pin the waddle client id)");
}
  const verifyJwt: VerifyJwt =
    opts.verifyJwt ??
    (async (token) => {
      if (!jwks) throw new Error("no jwks configured");
      // jose resolves { payload, protectedHeader } — the CONTRACT here is
      // the bare claims (what injected test legs return); unwrap so both
      // legs read identically downstream.
      const { payload } = await jwtVerify(token, jwks, { issuer: opts.issuer || undefined, audience: opts.audience || undefined });
      return payload;
    });

  return async (token: string | undefined): Promise<ExternalIdentity | null> => {
    if (!token) return null;
    if (jwks || opts.verifyJwt) {
      try {
        // Defensive against BOTH leg shapes: jose's default resolves
        // { payload, protectedHeader } (unwrapped above, but belt for
        // any future leg), injected legs resolve claims directly.
        const r = await verifyJwt(token);
        const claims =
          r && typeof r === "object" && "payload" in r && r.payload && typeof r.payload === "object"
            ? (r.payload as { sub?: unknown })
            : (r as { sub?: unknown } | undefined);
        // A JWT without a string sub can't key a user machine — treat it
        // as unverified (fall through to the secret leg).
        if (claims && typeof claims.sub === "string") return { kind: "jwt", sub: claims.sub };
      } catch {
        /* not a valid bb JWT — the shared secret is the other keyholder */
      }
    }
    return secretOk(token, opts.sharedSecret) ? { kind: "secret" } : null;
  };
}
