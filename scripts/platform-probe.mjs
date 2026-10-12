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
// The platform injects TINFOIL_API_KEY as env; a locally-run image takes
// it at unlock (compose shape). Either way the probe needs the agent live.
const inferenceKey = process.env.PROBE_INFERENCE_KEY || undefined;

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
  body: JSON.stringify({ secret, nonce: randomBytes(16).toString("base64"), inferenceKey }),
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
    let armed = false; // ignore the connect-time replay (hello + backlog) —
    // it re-delivers the PREVIOUS turn's tool events and assistant
    // message, which would bleed into this ask's collectors (live-caught
    // twice: task 2 scored against task 1's "Example Domain"). The arm
    // flips on replay_done, which terminates every connection's backlog.
    const done = () => {
      try { ws.close(); } catch {}
      resolve({ final, tools });
    };
    ws.onmessage = (m) => {
      const e = JSON.parse(m.data);
      if (e.type === "replay_done") { armed = true; return; }
      if (!armed) return;
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

/** Two devices on one machine: second unlock (same secret, fresh
 *  nonce → its own token), two sockets, ONE real turn — both must see
 *  the identical stream live, and closing one must not kill the other. */
async function multiClient() {
  const unlock2 = await fetch(`${BASE}/unlock`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret, nonce: randomBytes(16).toString("base64"), inferenceKey }),
  });
  const u2 = await unlock2.json();
  if (!u2.token || u2.token === u.token) throw new Error(`second unlock did not mint its own token: ${JSON.stringify(u2).slice(0, 120)}`);

  const collect = (token) => {
    const seen = { replayed: false, userEcho: null, assistant: [], deltas: 0 };
    const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(token)}`);
    const done = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("multi-client socket timeout")), 150_000);
      ws.onclose = () => { clearTimeout(t); resolve(seen); };
      ws.onerror = () => { clearTimeout(t); reject(new Error("socket error")); };
    });
    ws.onmessage = (m) => {
      const e = JSON.parse(m.data);
      if (e.type === "replay_done") { seen.replayed = true; return; }
      if (!seen.replayed) return; // ignore the connect-time backlog replay
      if (e.type === "approval_request") ws.send(JSON.stringify({ type: "approval_response", callId: e.callId, approved: true }));
      if (e.type === "delta") seen.deltas++;
      if (e.type === "message" && e.role === "user") seen.userEcho = e.text;
      if (e.type === "message" && e.role === "assistant") seen.assistant.push(e.text);
    };
    return { ws, seen, done, send: (o) => ws.send(JSON.stringify(o)) };
  };

  const a = collect(u.token);
  const b = collect(u2.token);
  await new Promise((resolve, reject) => {
    let opened = 0;
    const t = setTimeout(() => reject(new Error("connect timeout")), 20_000);
    for (const c of [a, b]) {
      c.ws.onopen = () => { if (++opened === 2) { clearTimeout(t); resolve(); } };
    }
  });
  await new Promise((r) => setTimeout(r, 1_500)); // replay_done lands for both
  if (!a.seen.replayed || !b.seen.replayed) throw new Error("replay never completed for both clients");

  // ONE turn, spoken on A: B must see the user's words AND the identical stream.
  a.send({ type: "user_message", text: "Reply with only the single word: fanout" });
  const waitFinal = (c, label) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (c.seen.assistant.length > 0) { clearInterval(iv); resolve(c.seen.assistant[0]); }
      else if (Date.now() - t0 > 120_000) { clearInterval(iv); reject(new Error(`${label} never saw the turn`)); }
    }, 250);
  });
  const [finalA, finalB] = await Promise.all([waitFinal(a, "A"), waitFinal(b, "B")]);

  // B leaves; A must keep streaming (close must not quiet the sink).
  b.ws.close();
  await new Promise((r) => setTimeout(r, 1_000));
  a.seen.assistant.length = 0; // only the post-close turn counts below
  a.send({ type: "user_message", text: "Reply with only the single word: survivor" });
  const survivor = await waitFinal(a, "A-after-B-closed");
  a.ws.close();
  await a.done.catch(() => {});

  return {
    pass: /fanout/i.test(finalA) && finalA === finalB && !!b.seen.userEcho?.includes("fanout") && /survivor/i.test(survivor),
    note: `A="${finalA.slice(0, 60)}" B="${finalB.slice(0, 60)}" identical=${finalA === finalB} userEchoOnB=${!!b.seen.userEcho} survivor="${survivor.slice(0, 40)}" deltasA=${a.seen.deltas} deltasB=${b.seen.deltas}`,
  };
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
  {
    name: "multi-client (two devices, one machine, one live turn)",
    run: multiClient,
  },
];

const results = [];
for (const t of TASKS) {
  try {
    const { pass, note } = t.run ? await t.run() : t.check(await ask(t.prompt));
    results.push({ name: t.name, pass });
    console.log(`[probe] ${pass ? "✓" : "✗"} ${t.name}\n         ${note}`);
  } catch (e) {
    results.push({ name: t.name, pass: false });
    console.log(`[probe] ✗ ${t.name} — ${e.message}`);
  }
}

writeFileSync(
  `.pi/evidence/platform-probe-v${health.version}.json`,
  JSON.stringify({ base: BASE, at: new Date().toISOString(), playpen: health.playpen, results }, null, 2),
);
const failed = results.filter((r) => !r.pass).length;
console.log(failed === 0 ? "[probe] PASS — demo path verified on the platform" : `[probe] FAIL — ${failed} task(s)`);
process.exit(failed === 0 ? 0 : 1);
