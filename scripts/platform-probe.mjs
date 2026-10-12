#!/usr/bin/env node
/**
 * Platform probe — the demo-critical live checks. Runs a real unlocked
 * session against a machine deployed in the exact prod shape (created
 * from the released waddle-config tag) and exercises the two paths a
 * demo will hit: the browser (post-v0.0.55: uid-free spawn on the
 * zero-capability platform) and codemode (QuickJS with a real model
 * turn). Enrolls its own throwaway secret — point it at a TEST machine,
 * never the user's (their verifier would 401 ours anyway).
 *
 * Usage: node scripts/platform-probe.mjs https://<machine>.containers.tinfoil.dev
 */
import { writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const BASE = process.argv[2]?.replace(/\/+$/, "");
if (!BASE) {
  console.error("usage: node scripts/platform-probe.mjs https://<machine>...");
  process.exit(1);
}
const secret = randomBytes(64).toString("base64");

// 1. Wait for the boot: cert issuance + deploy can take minutes.
let health = null;
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`${BASE}/health`);
    health = await r.json();
    if (health.version && health.locked === true) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 10_000));
}
if (!health?.version) {
  console.error("PROBE FAIL: machine never became healthy");
  process.exit(1);
}
console.log(`[probe] machine up: v${health.version} locked=${health.locked} playpen=${JSON.stringify(health.playpen)}`);

// 2. Unlock with our own secret (TOFU-enrolls on a fresh volume).
const unlock = await fetch(`${BASE}/unlock`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ secret, nonce: randomBytes(16).toString("base64") }),
});
const u = await unlock.json();
if (!u.token) {
  console.error("PROBE FAIL: unlock refused:", JSON.stringify(u));
  process.exit(1);
}
console.log("[probe] unlocked (TOFU) ✓");

/** One conversation over the gated WSS; auto-approves the ask-gate. */
function ask(text, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(u.token)}`);
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
      if (e.type === "tool_start") tools.push(`${e.tool}:${JSON.stringify(e.args).slice(0, 100)}`);
      if (e.type === "message" && e.role === "assistant") final = e.text;
      if (e.type === "error") reject(new Error(e.message));
    };
    ws.onopen = () => ws.send(JSON.stringify({ type: "user_message", text }));
    ws.onclose = () => (final !== null ? done() : reject(new Error("closed before final")));
    setTimeout(() => (final !== null ? done() : reject(new Error("timeout"))), timeoutMs);
  });
}

const TASKS = [
  {
    name: "browser (uid-free spawn on the zero-cap platform)",
    prompt:
      "Open https://example.com with the browser tool, then reply with only the page's main heading text.",
    check: (r) => ({
      pass: r.tools.some((t) => t.startsWith("browser_open:")) && /example domain/i.test(r.final ?? ""),
      note: `tools=[${r.tools.join(" | ")}] final=${(r.final ?? "").slice(0, 120)}`,
    }),
  },
  {
    name: "codemode (QuickJS with a real model turn)",
    prompt: "Use codemode to compute 17*23, then reply with only the number.",
    check: (r) => ({
      pass: r.tools.some((t) => t.startsWith("codemode:")) && /391/.test(r.final ?? ""),
      note: `tools=[${r.tools.join(" | ")}] final=${(r.final ?? "").slice(0, 120)}`,
    }),
  },
];

const results = [];
for (const t of TASKS) {
  try {
    const r = await ask(t.prompt);
    const { pass, note } = t.check(r);
    results.push({ name: t.name, pass });
    console.log(`[probe] ${pass ? "✓" : "✗"} ${t.name}\n         ${note}`);
  } catch (e) {
    results.push({ name: t.name, pass: false });
    console.log(`[probe] ✗ ${t.name} — ${e.message}`);
  }
}

writeFileSync(
  ".pi/evidence/platform-probe-v0.0.55.json",
  JSON.stringify({ base: BASE, at: new Date().toISOString(), playpen: health.playpen, results }, null, 2),
);
const failed = results.filter((r) => !r.pass).length;
console.log(failed === 0 ? "[probe] PASS — demo path verified on the platform" : `[probe] FAIL — ${failed} task(s)`);
process.exit(failed === 0 ? 0 : 1);
