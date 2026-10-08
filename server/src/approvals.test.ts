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

test("browser_open: allowlisted domains pass — bare domains normalize like the tool", () => {
  assert.equal(needsApproval("browser_open", { url: "news.ycombinator.com" }), false);
  assert.equal(needsApproval("browser_open", { url: "https://news.ycombinator.com/" }), false);
  assert.equal(needsApproval("browser_open", { url: "https://sub.en.wikipedia.org/wiki/X" }), false);
});

test("browser_open: non-listed or malformed domains ask", () => {
  assert.equal(needsApproval("browser_open", { url: "https://evil.example.net/" }), true);
  assert.equal(needsApproval("browser_open", { url: "not a url" }), true);
  assert.equal(needsApproval("browser_open", {}), true);
});

test("browser clicks/snapshots/typing auto-allow (the URL gate is on open)", () => {
  assert.equal(needsApproval("browser_snapshot", {}), false);
  assert.equal(needsApproval("browser_click", { index: 3 }), false);
  assert.equal(needsApproval("browser_type", { index: 2, text: "hi" }), false);
});

test("browser_scroll auto-allows (reading motion, not a new destination)", () => {
  assert.equal(needsApproval("browser_scroll", { direction: "down", amount: 800 }), false);
  assert.equal(needsApproval("browser_scroll", { direction: "up" }), false);
});
