/**
 * The tripwires, no-shell edition: typed parameters only — file paths for
 * the file tools, URLs for the browser. Run: node --import tsx --test
 * src/guard/tripwire.test.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
const scratch = mkdtempSync(join(tmpdir(), "waddle-tripwire-"));
process.env.DATA_DIR = scratch;
const DATA = scratch;

const { checkToolCall } = await import("./tripwire.js");

test("write/edit: system-tree targets block, workspace allows", () => {
  for (const tool of ["write", "edit"]) {
    assert.match(checkToolCall(tool, { path: `${DATA}/schedules.json` }).verdict, /block/);
    assert.match(checkToolCall(tool, { path: `${DATA}/log/events.jsonl` }).verdict, /block/);
    assert.match(checkToolCall(tool, { path: `${DATA}/browser/Default/Cookies` }).verdict, /block/);
    assert.match(checkToolCall(tool, { path: "../schedules.json" }).verdict, /block/); // traversal
    assert.match(checkToolCall(tool, { path: `a/../../log/x` }).verdict, /block/); // nested traversal
    assert.match(checkToolCall(tool, { path: "notes.txt" }).verdict, /allow/);
    assert.match(checkToolCall(tool, { path: `${DATA}/workspace/deep/file.txt` }).verdict, /allow/);
    assert.match(checkToolCall(tool, { path: `${DATA}/tmp/spool` }).verdict, /allow/); // shared tmp is the agent's
  }
});

test("read/grep/find/ls: system-tree reads block — lexically AND through symlinks", () => {
  for (const tool of ["read", "grep", "find", "ls"]) {
    assert.match(checkToolCall(tool, { path: `${DATA}/log/events.jsonl` }).verdict, /block/);
    assert.match(checkToolCall(tool, { path: `${DATA}/wake-credential.json` }).verdict, /block/);
    assert.match(checkToolCall(tool, { path: "../verifier.bin" }).verdict, /block/);
    assert.match(checkToolCall(tool, { path: "notes.txt" }).verdict, /allow/);
    assert.match(checkToolCall(tool, { path: "" }).verdict, /allow/); // absent path: the tool's cwd (workspace)
  }
});

test("read through a planted symlink into the system tree blocks (realpath, not lexical)", () => {
  // A restored hostile archive can plant links; the read tools run as root.
  mkdirSync(join(DATA, "log"), { recursive: true });
  writeFileSync(join(DATA, "log", "events.jsonl"), "sealed");
  mkdirSync(join(DATA, "workspace"), { recursive: true });
  symlinkSync(join(DATA, "log"), join(DATA, "workspace", "sneaky"));
  try {
    assert.match(checkToolCall("read", { path: "sneaky/events.jsonl" }).verdict, /block/, "lexically in-workspace, really the log — must block");
    // A link that stays inside the workspace reads fine.
    symlinkSync("notes.txt", join(DATA, "workspace", "inner"));
    assert.match(checkToolCall("read", { path: "inner" }).verdict, /allow/);
  } finally {
    rmSync(join(DATA, "workspace", "sneaky"), { force: true });
    rmSync(join(DATA, "workspace", "inner"), { force: true });
  }
});

test("reads outside DATA_DIR are not this layer's fight (the tools may read /etc)", () => {
  assert.match(checkToolCall("read", { path: "/etc/passwd" }).verdict, /allow/);
  assert.match(checkToolCall("grep", { pattern: "x", path: "/usr/share" }).verdict, /allow/);
});

after(() => rmSync(scratch, { recursive: true, force: true }));

test("browser_open: the concierge and the CDP endpoint block, ordinary URLs allow", () => {
  const concierge = process.env.CONCIERGE_URL
    ? checkToolCall("browser_open", { url: process.env.CONCIERGE_URL })
    : null;
  if (concierge) {
    assert.match(concierge.verdict, /block/);
    if (concierge.verdict === "block") assert.match(concierge.reason, /concierge/);
  }
  const cdp = checkToolCall("browser_open", { url: "http://localhost:9222/json/version" });
  assert.match(cdp.verdict, /block/);
  const plain = checkToolCall("browser_open", { url: "https://en.wikipedia.org/wiki/Duck" });
  assert.match(plain.verdict, /allow/);
});

test("unknown tools default open", () => {
  assert.match(checkToolCall("codemode", { script: "return tools.read({path: 'x'})" }).verdict, /allow/);
  assert.match(checkToolCall("browser_click", { ref: "e1" }).verdict, /allow/);
});
