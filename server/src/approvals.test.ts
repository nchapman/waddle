/**
 * Ask-gate policy tests — the security-critical decision (which calls the
 * human must see) runs here. Run: node --test src/approvals.test.ts (or via
 * tsx). Policy: reads auto-allow; writes auto-allow in-workspace only;
 * bash always asks; absent paths ask.
 */
import assert from "node:assert/strict";
import test from "node:test";

process.env.DATA_DIR = "/tmp/waddle-data";
const { needsApproval } = await import("./approvals.js");

const WS = "/tmp/waddle-data/workspace";

test("reads auto-allow", () => {
  assert.equal(needsApproval("read", { path: "/etc/passwd" }), false);
  assert.equal(needsApproval("grep", { pattern: "x" }), false);
  assert.equal(needsApproval("find", { pattern: "x" }), false);
  assert.equal(needsApproval("ls", {}), false);
});

test("bash always asks", () => {
  assert.equal(needsApproval("bash", { command: "ls" }), true);
  assert.equal(needsApproval("bash", { command: "echo hi" }), true);
});

test("writes auto-allow inside the workspace", () => {
  assert.equal(needsApproval("write", { path: "notes.txt" }), false);
  assert.equal(needsApproval("write", { path: `${WS}/notes.txt` }), false);
  assert.equal(needsApproval("write", { path: "./nested/deep.txt" }), false);
});

test("writes outside the workspace ask", () => {
  assert.equal(needsApproval("write", { path: "/etc/cron.d/evil" }), true);
  assert.equal(needsApproval("edit", { path: "/root/.ssh/authorized_keys" }), true);
});

test("traversal cannot smuggle a write out of the workspace", () => {
  assert.equal(needsApproval("write", { path: "../../../etc/passwd" }), true);
  assert.equal(needsApproval("edit", { path: `${WS}/../../escape.txt` }), true);
  assert.equal(needsApproval("write", { path: "a/../../b.txt" }), true);
});

test("absent or empty path asks, never assumes", () => {
  assert.equal(needsApproval("write", {}), true);
  assert.equal(needsApproval("write", { path: "" }), true);
  assert.equal(needsApproval("edit", {}), true);
});
