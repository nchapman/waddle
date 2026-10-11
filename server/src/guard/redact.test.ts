/**
 * Redaction at the transcript boundary: values become markers, structured
 * output included, and clean text passes through untouched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerSecret, unregisterSecret } from "./policy.js";
import { containsSecret, scrubJson, scrubSecrets } from "./redact.js";

const NAME = "redact-test-secret";
const VALUE = "super-secret-value-xyz";

test.before(() => registerSecret(NAME, VALUE));
test.after(() => unregisterSecret(NAME));

test("scrubSecrets replaces every occurrence with the named marker", () => {
  assert.equal(scrubSecrets(`before ${VALUE} mid ${VALUE} after`), `before [REDACTED:${NAME}] mid [REDACTED:${NAME}] after`);
});

test("scrubSecrets leaves clean text untouched", () => {
  const clean = "just some ordinary output\nwith lines";
  assert.equal(scrubSecrets(clean), clean);
});

test("scrubSecrets is literal, not regex (regex metachars in values are safe)", () => {
  const re_name = "redact-regex-secret";
  registerSecret(re_name, "a.b*c(d)");
  try {
    assert.equal(scrubSecrets("x a.b*c(d) y"), `x [REDACTED:${re_name}] y`);
    assert.equal(scrubSecrets("abcd"), "abcd"); // no false hit on the pattern
  } finally {
    unregisterSecret(re_name);
  }
});

test("containsSecret detects but does not mutate", () => {
  const text = `leak: ${VALUE}`;
  assert.ok(containsSecret(text));
  assert.ok(!containsSecret("nothing here"));
});

test("scrubJson recurses and preserves clean references", () => {
  const structured = {
    output: `echo says ${VALUE}`,
    truncated: false,
    exit_code: 0,
    nested: [{ text: `also ${VALUE}` }],
    full_output_path: "/tmp/pi-bash-xyz",
  };
  const out = scrubJson(structured);
  assert.equal(out.output, `echo says [REDACTED:${NAME}]`);
  assert.equal(out.nested?.[0]?.text, `also [REDACTED:${NAME}]`);
  assert.equal(out.exit_code, 0);
  assert.equal(out.full_output_path, "/tmp/pi-bash-xyz");

  const clean = { a: 1, b: ["x", { c: true }] };
  assert.equal(scrubJson(clean), clean, "clean values keep their reference");
});
