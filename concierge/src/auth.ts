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
}): (token: string | undefined) => Promise<boolean> {
  const jwks = opts.jwksUrl ? createRemoteJWKSet(new URL(opts.jwksUrl)) : null;
  const verifyJwt: VerifyJwt =
    opts.verifyJwt ??
    (async (token) => {
      if (!jwks) throw new Error("no jwks configured");
      return jwtVerify(token, jwks, { issuer: opts.issuer || undefined, audience: opts.audience || undefined });
    });

  return async (token: string | undefined): Promise<boolean> => {
    if (!token) return false;
    if (jwks || opts.verifyJwt) {
      try {
        await verifyJwt(token);
        return true;
      } catch {
        /* not a valid bb JWT — the shared secret is the other keyholder */
      }
    }
    return secretOk(token, opts.sharedSecret);
  };
}
