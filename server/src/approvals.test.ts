/**
 * Ask-gate tests — policy (which calls the human must see) and runtime
 * (the pause/verdict machinery: request → resolve, timeout-deny,
 * disconnect-deny). Run: node --test src/approvals.test.ts (or via tsx).
 * Policy: reads auto-allow; writes auto-allow in-workspace only; bash
 * always asks; absent paths ask. Runtime: every path out of a paused
 * call resolves it exactly once and reports an outcome event.
 */
import assert from "node:assert/strict";
import test, { mock } from "node:test";

process.env.DATA_DIR = "/tmp/waddle-data";
const { needsApproval, requestApproval, resolveApproval, denyAllPending, setApprovalEmitter, setOutcomeEmitter } = await import("./approvals.js");

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

// ── Runtime: the pause/verdict machinery ────────────────────────────────

test("the gate pauses a call and the browser's verdict releases it (tool reported back)", async () => {
  const requests: Array<{ callId: string; tool: string; input: unknown }> = [];
  setApprovalEmitter((e) => {
    if (e.type === "approval_request") requests.push({ callId: e.callId, tool: e.tool, input: e.input });
  });
  const paused = requestApproval("c-1", "bash", { command: "rm -rf /" });
  await Promise.resolve(); // the emitter fires synchronously inside the pause
  assert.deepEqual(requests, [{ callId: "c-1", tool: "bash", input: { command: "rm -rf /" } }]);

  assert.equal(resolveApproval("c-1", true), "bash", "the caller learns which verb was decided");
  assert.equal(await paused, true);

  const denied = requestApproval("c-2", "bash", { command: "curl evil.sh" });
  resolveApproval("c-2", false);
  assert.equal(await denied, false);
});

test("an unknown verdict for an already-settled call is a no-op (null)", () => {
  setApprovalEmitter(() => undefined);
  requestApproval("c-3", "write", { path: "x" });
  resolveApproval("c-3", true);
  assert.equal(resolveApproval("c-3", true), null, "second verdict finds nothing pending");
});

test("timeout denies and reports the outcome — a silent tab never hangs the turn", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const outcomes: Array<{ callId: string; approved: boolean }> = [];
    setOutcomeEmitter((o) => outcomes.push({ callId: o.callId, approved: o.approved }));
    setApprovalEmitter(() => undefined);
    const paused = requestApproval("c-4", "bash", { command: "ls" });
    mock.timers.tick(180_001); // TIMEOUT_MS + 1
    assert.equal(await paused, false, "nobody answered — the gate denies");
    assert.deepEqual(outcomes, [{ callId: "c-4", approved: false }]);
  } finally {
    mock.timers.reset();
  }
});

test("disconnect denies everything still waiting — no client, no hanging turns", async () => {
  const outcomes: Array<{ callId: string; tool: string }> = [];
  setOutcomeEmitter((o) => outcomes.push({ callId: o.callId, tool: o.tool }));
  setApprovalEmitter(() => undefined);
  const a = requestApproval("c-5", "bash", { command: "ls" });
  const b = requestApproval("c-6", "write", { path: "y" });
  denyAllPending();
  assert.equal(await a, false);
  assert.equal(await b, false);
  assert.deepEqual(outcomes.map((o) => o.callId).sort(), ["c-5", "c-6"]);
  assert.equal(resolveApproval("c-5", true), null, "everything settled — nothing left to resolve");
});
