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
  assert.equal(await verify("s3cret"), true);
  assert.equal(await verify("not-a-jwt"), false);
  assert.equal(await verify(undefined), false);
});

test("valid bb JWT passes even when the secret would not", async () => {
  const verify = createVerifyExternal({
    sharedSecret: "s3cret",
    verifyJwt: async (t) => {
      if (t === "good-jwt") return { sub: "user-1" };
      throw new Error("bad signature");
    },
  });
  assert.equal(await verify("good-jwt"), true);
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
  assert.equal(await verify("s3cret"), true);
  assert.equal(await verify("neither-key"), false);
});

test("neither key: rejected", async () => {
  const verify = createVerifyExternal({
    jwksUrl: "https://accounts.example.dev/.well-known/jwks.json",
    sharedSecret: "s3cret",
    verifyJwt: async () => {
      throw new Error("bad");
    },
  });
  assert.equal(await verify("wrong-token"), false);
  assert.equal(await verify(undefined), false);
});
