/**
 * The playpen policy: env scrubbing and the secret registry. The load-
 * bearing property is negative — no child env ever carries the platform
 * secrets, whatever the gateway's own env holds.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SECRET_FLOOR,
  registerBootSecrets,
  registerSecret,
  registeredSecrets,
  scrubEnv,
  unregisterSecret,
} from "./policy.js";

test("scrubEnv keeps the allowlist and drops everything else", () => {
  const out = scrubEnv({
    PATH: "/usr/local/bin:/usr/bin",
    HOME: "/root",
    TMPDIR: "/tmp",
    TZ: "UTC",
    LANG: "en_US.UTF-8",
    LC_ALL: "C",
    TERM: "xterm-256color",
    SHELL: "/bin/bash",
    XDG_CONFIG_HOME: "/root/.config",
    PI_SESSION_ID: "sess-1",
    CONCIERGE_SHARED_SECRET: "gateway-only-secret-value",
    TINFOIL_API_KEY: "gateway-only-key-value",
    WADDLE_BROWSER_ALLOWLIST: "example.com",
    NODE_ENV: "production",
    PATH_EXTRA: "no",
  });
  assert.equal(out.PATH, "/usr/local/bin:/usr/bin");
  assert.equal(out.HOME, "/root");
  assert.equal(out.TMPDIR, "/tmp");
  assert.equal(out.PI_SESSION_ID, "sess-1");
  assert.equal(out.LC_ALL, "C");
  for (const banned of [
    "CONCIERGE_SHARED_SECRET",
    "TINFOIL_API_KEY",
    "WADDLE_BROWSER_ALLOWLIST",
    "NODE_ENV",
    "PATH_EXTRA",
  ]) {
    assert.ok(!(banned in out), `${banned} must not survive the scrub`);
  }
});

test("scrubEnv drops undefined-valued keys entirely", () => {
  const out = scrubEnv({ HOME: "/root", CONCIERGE_SHARED_SECRET: undefined });
  assert.deepEqual(out, { HOME: "/root" });
});

test("secret registry: registers, floors short values, unregisters", () => {
  registerSecret("test-secret", "a-value-long-enough");
  assert.deepEqual(registeredSecrets().filter(([n]) => n === "test-secret"), [["test-secret", "a-value-long-enough"]]);
  unregisterSecret("test-secret");
  assert.ok(!registeredSecrets().some(([n]) => n === "test-secret"));

  registerSecret("too-short", "short");
  registerSecret("empty", "");
  registerSecret("absent", undefined);
  assert.ok(!registeredSecrets().some(([n]) => n.startsWith("too-short") || n === "empty" || n === "absent"));
  assert.ok(SECRET_FLOOR >= 8, "the floor must stay high enough to avoid noise");
});

test("registerBootSecrets picks up the platform secrets", () => {
  registerBootSecrets({
    CONCIERGE_SHARED_SECRET: "concierge-secret-123456",
    TINFOIL_API_KEY: "inference-key-123456",
  } as NodeJS.ProcessEnv);
  const names = registeredSecrets().map(([n]) => n);
  assert.ok(names.includes("concierge-shared-secret"));
  assert.ok(names.includes("inference-key"));
  unregisterSecret("concierge-shared-secret");
  unregisterSecret("inference-key");
});
