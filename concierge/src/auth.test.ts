import { test } from "node:test";
import assert from "node:assert/strict";
import { createVerifyExternal, secretOk } from "./auth.js";

test("secretOk: exact match passes, everything else fails", () => {
  assert.equal(secretOk("s3cret", "s3cret"), true);
  assert.equal(secretOk("s3cret", "other"), false);
  assert.equal(secretOk("s3cr", "s3cret"), false); // length mismatch, no throw
  assert.equal(secretOk(undefined, "s3cret"), false);
  assert.equal(secretOk("s3cret", undefined), false);
});

test("no JWKS configured: shared secret is the only key", async () => {
  const verify = createVerifyExternal({ sharedSecret: "s3cret" });
  assert.deepEqual(await verify("s3cret"), { kind: "secret" });
  assert.equal(await verify("not-a-jwt"), null);
  assert.equal(await verify(undefined), null);
});

test("valid bb JWT passes even when the secret would not", async () => {
  const verify = createVerifyExternal({
    sharedSecret: "s3cret",
    verifyJwt: async (t) => {
      if (t === "good-jwt") return { sub: "user-1" };
      throw new Error("bad signature");
    },
  });
  assert.deepEqual(await verify("good-jwt"), { kind: "jwt", sub: "user-1" });
});

test("JWKS configured does NOT lock machines out: a failed JWT falls through to the shared secret", async () => {
  // The sleep gate arms escrows with the shared secret bearer — this path
  // is why verifyExternal must try both keys, not JWT-only.
  const verify = createVerifyExternal({
    jwksUrl: "https://accounts.example.dev/.well-known/jwks.json",
    sharedSecret: "s3cret",
    verifyJwt: async () => {
      throw new Error("not a bb JWT");
    },
  });
  assert.deepEqual(await verify("s3cret"), { kind: "secret" });
  assert.equal(await verify("neither-key"), null);
});

test("neither key: rejected", async () => {
  const verify = createVerifyExternal({
    jwksUrl: "https://accounts.example.dev/.well-known/jwks.json",
    sharedSecret: "s3cret",
    verifyJwt: async () => {
      throw new Error("bad");
    },
  });
  assert.equal(await verify("wrong-token"), null);
  assert.equal(await verify(undefined), null);
});

test("a JWT without a string sub is NOT a user identity — falls through to the secret", async () => {
  // /boot keys machines by sub; a token that verifies but carries no sub
  // must not silently pass as a user. (It also isn't the secret, so the
  // whole verify returns null — bearer of nothing.)
  const verify = createVerifyExternal({
    sharedSecret: "s3cret",
    verifyJwt: async () => ({ sub: 12345 }),
  });
  assert.equal(await verify("sub-less-jwt"), null);
  assert.deepEqual(await verify("s3cret"), { kind: "secret" });
});

test("a jose-shaped leg result ({payload}) unwraps to claims — both leg shapes verify", async () => {
  // The default leg destructures jose's {payload, protectedHeader}; the
  // reader must ALSO survive a leg that hands back the wrapper raw.
  const verify = createVerifyExternal({
    verifyJwt: async () => ({ payload: { sub: "user-9" } }),
  });
  assert.deepEqual(await verify("wrapper-jwt"), { kind: "jwt", sub: "user-9" });
});
