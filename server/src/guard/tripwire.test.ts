/**
 * The tripwires: egregious-pattern verdicts. These are deliberately few —
 * the layer catches accidents and injected nonsense with clear reasons;
 * deliberate obfuscation is slice 2's (kernel) problem, not this one's.
 * DATA_DIR and CONCIERGE_URL are read at module load, so they are pinned
 * before the dynamic import.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = "/data"; // prod-shaped
process.env.CONCIERGE_URL = "https://concierge.example";
const { checkToolCall } = await import("./tripwire.js");

const allow = (tool: string, input: Record<string, unknown>, why = "should allow") => {
  const v = checkToolCall(tool, input);
  assert.equal(v.verdict, "allow", `${tool} ${JSON.stringify(input)} should allow (${why})`);
};

const block = (tool: string, input: Record<string, unknown>, why: string) => {
  const v = checkToolCall(tool, input);
  assert.equal(v.verdict, "block", `${tool} ${JSON.stringify(input)} should block (${why})`);
  assert.ok(v.verdict === "block" && v.reason.length > 0, "blocks carry an actionable reason");
};

test("bash: ordinary work allows — the playpen is permissive", () => {
  allow("bash", { command: "ls -la && grep -r waddle . | head" });
  allow("bash", { command: "curl -s https://example.com/api | jq ." });
  allow("bash", { command: "rm -rf build && make -j4" });
  allow("bash", { command: "echo done > notes.txt" });
  allow("bash", { command: "git init && git add -A" });
});

test("bash: agent roots under DATA_DIR are the playpen, not the system", () => {
  allow("bash", { command: "rm -rf /data/workspace/build" });
  allow("bash", { command: "cat /data/workspace/notes.txt > out.txt" });
  allow("bash", { command: "ls /data/workspace /data/tmp /data/home" });
});

test("bash: reading system state is not this layer's fight (uid is slice 2)", () => {
  allow("bash", { command: "cat /data/verifier.bin | head -c 32" });
  allow("bash", { command: "ls /data/log" });
});

test("bash: destroying system state blocks", () => {
  block("bash", { command: "rm /data/verifier.bin" }, "verifier");
  block("bash", { command: "rm -rf /data/log" }, "log");
  block("bash", { command: "mv /data/schedules.json /tmp/" }, "schedules");
  block("bash", { command: "truncate -s 0 /data/log/events.jsonl" }, "log truncate");
  block("bash", { command: "dd if=/dev/zero of=/data/verifier.bin" }, "verifier dd");
  block("bash", { command: "chmod 777 /data/browser" }, "browser profile");
  block("bash", { command: "rm -rf /data" }, "the DATA_DIR root itself");
  block("bash", { command: "rm -rf ../log" }, "relative escape from the workspace");
});

test("bash: redirects into the system tree block, redirects out of it allow", () => {
  block("bash", { command: "echo tampered > /data/schedules.json" }, "redirect at schedules");
  block("bash", { command: "echo more >> /data/log/events.jsonl" }, "append at the log");
  allow("bash", { command: "cat /data/log/events.jsonl > workspace-copy.txt" }); // mention ≠ target
  allow("bash", { command: "echo hi > /data/workspace/out.txt" });
});

test("bash: killing the gateway or browser blocks", () => {
  block("bash", { command: "pkill node" }, "gateway");
  block("bash", { command: "pkill -f chromium || killall chrome" }, "browser");
  allow("bash", { command: "pkill -f my-own-script.sh" }, "its own children are its business");
});

test("bash: the agent never talks to the concierge directly", () => {
  block("bash", { command: "curl -X POST https://concierge.example/handoff -d '{}'" }, "concierge client");
  block("bash", { command: "wget https://CONCIERGE.EXAMPLE/status" }, "case-insensitive host");
  allow("bash", { command: "curl -s https://api.tinfoil.sh/models" }, "the wide web is the playpen's");
});

test("write/edit: system-tree targets block, workspace allows", () => {
  block("write", { path: "/data/schedules.json" }, "absolute system path");
  block("edit", { path: "../log/events.jsonl" }, "relative escape");
  block("edit", { path: "a/../../log/events.jsonl" }, "nested-dotdot escape");
  block("write", { path: "/data/workspace/a/../../pi-agent/auth.json" }, "nested-dotdot, absolute");
  block("write", { path: "/data" }, "the DATA_DIR root");
  allow("write", { path: "notes.txt" });
  allow("edit", { path: "/data/workspace/src/app.ts" });
  allow("write", { path: "a/../notes.txt" }, "dotdots that stay inside the workspace");
  allow("write", { path: "/etc/hosts" }); // not system-tree: the ask-gate's call, not the tripwire's
});

test("unknown and read tools default open", () => {
  allow("read", { path: "/data/verifier.bin" }); // reading is not this layer's fight
  allow("browser_open", { url: "https://anything.example" });
  allow("schedule_create", { title: "x", prompt: "y" });
  allow("mystery-tool", {});
});
