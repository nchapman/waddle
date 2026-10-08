#!/usr/bin/env node
/**
 * Tool-use eval — the go/no-go seed for the brain.
 * Same harness the browser uses: unlock + WSS + the real ask-gate (the
 * script answers approvals itself). Runs a fixed task suite against the
 * running compose server and records pass/fail with evidence.
 *
 * Usage: node scripts/eval-tools.mjs [label]
 * Prereq: compose up, volume fresh or any state; script enrolls its own secret.
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const BASE = "http://localhost:8080";
const crypto = await import("node:crypto");

const secret = crypto.randomBytes(64).toString("base64");
const label = process.argv[2] ?? process.env.WADDLE_MODEL ?? "unknown";

// The model under test, from the container env (source of truth).
const env = spawnSync("docker", ["exec", "waddle", "printenv", "WADDLE_MODEL"], { encoding: "utf8" });
const model = env.stdout.trim() || label;

const key = process.env.TINFOIL_API_KEY;
if (!key) {
  console.error("TINFOIL_API_KEY required");
  process.exit(1);
}

const r = await fetch(`${BASE}/unlock`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ secret, nonce: crypto.randomBytes(16).toString("base64"), inferenceKey: key }),
});
const u = await r.json();
if (!u.token) {
  console.error("unlock failed:", JSON.stringify(u));
  process.exit(1);
}

/** One conversation over the gated WSS; auto-approves the ask-gate. */
function ask(text) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:8080/ws?token=${encodeURIComponent(u.token)}`);
    const tools = [];
    let final = null;
    const done = () => {
      try { ws.close(); } catch {}
      resolve({ final, tools });
    };
    ws.onmessage = (m) => {
      const e = JSON.parse(m.data);
      if (e.type === "approval_request") {
        ws.send(JSON.stringify({ type: "approval_response", callId: e.callId, approved: true }));
        return;
      }
      if (e.type === "tool_start") tools.push(`${e.tool}:${JSON.stringify(e.args).slice(0, 80)}`);
      if (e.type === "message" && e.role === "assistant") final = e.text;
      if (e.type === "error") reject(new Error(e.message));
    };
    ws.onopen = () => ws.send(JSON.stringify({ type: "user_message", text }));
    ws.onclose = () => final !== null ? done() : reject(new Error("closed before final"));
    setTimeout(() => (final !== null ? done() : reject(new Error("timeout"))), 90_000);
  });
}

const docker = (cmd) =>
  spawnSync("docker", ["exec", "waddle", "sh", "-c", cmd], { encoding: "utf8" });

const TASKS = [
  {
    name: "write-file",
    prompt: "Create a file called eval-a.txt containing exactly: alpha-bravo-42 (no other text). Then reply with just: DONE",
    check: () => docker("cat /data/workspace/eval-a.txt").stdout.trim() === "alpha-bravo-42",
  },
  {
    name: "read-file",
    setup: () => docker("echo token-zulu-99 > /data/workspace/eval-b.txt"),
    prompt: "Read eval-b.txt and reply with only the token it contains.",
    checkReply: (reply) => /token-zulu-99/.test(reply),
  },
  {
    name: "edit-file",
    setup: () => docker(`printf '{"a":1}' > /data/workspace/eval-c.json`),
    prompt: 'In eval-c.json change the value of "a" from 1 to 2, keeping valid JSON. Reply DONE.',
    check: () => {
      const out = docker("cat /data/workspace/eval-c.json").stdout.trim();
      try { return JSON.parse(out).a === 2; } catch { return false; }
    },
  },
  {
    name: "bash-compute",
    prompt: "Use the bash tool to compute 17*23. Reply with only the number.",
    checkReply: (reply) => /391/.test(reply),
  },
  {
    name: "multi-step",
    prompt: "Multi-step: use bash to run mkdir -p logs/app, then use write to create logs/app/run.txt containing ok, then read it back and tell me exactly what it says.",
    check: () => docker("cat /data/workspace/logs/app/run.txt").stdout.trim() === "ok",
  },
];

const results = [];
const flush = () => {
  const score = results.filter((x) => x.pass).length;
  writeFileSync(
    `evals/tools-${model}.json`,
    JSON.stringify({ model, at: new Date().toISOString(), score, total: TASKS.length, results }, null, 2),
  );
};
for (const task of TASKS) {
  task.setup?.();
  let pass = false, reply = null, tools = [], err = null;
  try {
    ({ final: reply, tools } = await ask(task.prompt));
    await new Promise((r2) => setTimeout(r2, 500));
    pass = task.checkReply ? task.checkReply(reply ?? "") : task.check();
  } catch (e) {
    err = e.message;
  }
  results.push({ name: task.name, pass, toolCalls: tools.length, reply: (reply ?? "").slice(0, 140), err });
  flush();
  console.error(`${pass ? "PASS" : "FAIL"} ${task.name}${err ? ` (${err})` : ""} [tools: ${tools.length}]`);
}

flush();
console.log(`score: ${results.filter((x) => x.pass).length}/${TASKS.length} (${model})`);
