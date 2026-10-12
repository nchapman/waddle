/**
 * The ask-gate: decisions for the no-shell tool set (browser URL asks,
 * autonomous-run conversion) plus the request/resolve plumbing.
 * Run: node --import tsx --test src/approvals.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// The gate reads DATA_DIR at import — scratch dir first (own test process).
const scratch = mkdtempSync(join(tmpdir(), "waddle-approvals-"));
process.env.DATA_DIR = scratch;

const {
  gateDecision,
  requestApproval,
  resolveApproval,
  denyAllPending,
  setApprovalEmitter,
  setOutcomeEmitter,
  setAutonomousTurn,
} = await import("./approvals.js");

const OUTSIDE_URL = { url: "https://some-random-site.example/feed" };
const ALLOWED_URL = { url: "https://en.wikipedia.org/wiki/Duck" };

test("file tools allow inside the workspace — never ask", () => {
  assert.deepEqual(gateDecision("write", { path: "notes.txt" }), { action: "allow" });
  assert.deepEqual(gateDecision("edit", { path: "notes.txt" }), { action: "allow" });
  assert.deepEqual(gateDecision("read", { path: "notes.txt" }), { action: "allow" });
});

test("file tools block the system tree with a reason", () => {
  const decision = gateDecision("write", { path: "../schedules.json" });
  assert.equal(decision.action, "block");
  if (decision.action === "block") assert.match(decision.reason, /system state/);
  // reads of the system tree block too (the tools run as root; the kernel cannot gate them)
  assert.equal(gateDecision("read", { path: `${scratch}/log/events.jsonl` }).action, "block");
  assert.equal(gateDecision("grep", { pattern: "x", path: `${scratch}/log` }).action, "block");
});

test("browser_open: allowlisted domains pass, others ask", () => {
  assert.deepEqual(gateDecision("browser_open", ALLOWED_URL), { action: "allow" });
  assert.deepEqual(gateDecision("browser_open", { url: "news.ycombinator.com" }), { action: "allow" });
  const outside = gateDecision("browser_open", OUTSIDE_URL);
  assert.equal(outside.action, "ask");
});

test("browser_open: the concierge and the CDP endpoint block outright", () => {
  const concierge = gateDecision("browser_open", { url: process.env.CONCIERGE_URL ?? "https://waddle-concierge.containers.tinfoil.dev" });
  if (process.env.CONCIERGE_URL) {
    assert.equal(concierge.action, "block");
    if (concierge.action === "block") assert.match(concierge.reason, /concierge/);
  }
  const cdp = gateDecision("browser_open", { url: "http://127.0.0.1:9222/json/list" });
  assert.equal(cdp.action, "block");
  if (cdp.action === "block") assert.match(cdp.reason, /CDP/);
});

test("autonomous runs convert asks into immediate blocks with a usable reason", () => {
  setAutonomousTurn(true);
  try {
    const decision = gateDecision("browser_open", OUTSIDE_URL);
    assert.equal(decision.action, "block");
    if (decision.action === "block") assert.match(decision.reason, /no user|allowlist/);
    // allowlisted still passes — autonomy narrows the ask set, not the allow set
    assert.deepEqual(gateDecision("browser_open", ALLOWED_URL), { action: "allow" });
  } finally {
    setAutonomousTurn(false);
  }
});

test("unknown tools allow — the playpen defaults open", () => {
  assert.deepEqual(gateDecision("codemode", { script: "return 1" }), { action: "allow" });
  assert.deepEqual(gateDecision("browser_snapshot", {}), { action: "allow" });
  assert.deepEqual(gateDecision("schedule_create", { prompt: "x" }), { action: "allow" });
});

test("request/resolve: the browser's yes unblocks the call", async () => {
  const events: unknown[] = [];
  setApprovalEmitter((e) => events.push(e));
  const verdict = requestApproval("call-1", "browser_open", OUTSIDE_URL);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(events.length, 1, "the request reached the emitter");
  const tool = resolveApproval("call-1", true);
  assert.equal(tool, "browser_open");
  assert.equal(await verdict, true);
});

test("request/denyAllPending: shutdown denies everything still waiting", async () => {
  const outcomes: unknown[] = [];
  setOutcomeEmitter((o) => outcomes.push(o));
  const verdict = requestApproval("call-2", "browser_open", OUTSIDE_URL);
  denyAllPending();
  assert.equal(await verdict, false);
  assert.equal(outcomes.length, 1);
  // a late resolve for an already-denied call is a no-op
  assert.equal(resolveApproval("call-2", true), null);
});
