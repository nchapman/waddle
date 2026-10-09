// Regression (v0.0.38 bug): a machine that sat LOCKED longer than IDLE_MS
// must not be reaped when its first unlock finally arrives. Sequence: boot →
// wait locked past idle → unlock + WS → the gate must start counting from
// the UNLOCK, so no sleep before t0+IDLE, and a graceful sleep after.
const B = "http://localhost:8080";
const IDLE = 120_000;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

let h = await fetch(`${B}/health`).then((r) => r.json());
if (!h || h.service !== "waddle-server") throw new Error("not up: " + JSON.stringify(h));
if (!h.locked) throw new Error("not locked — need a fresh volume; docker compose down -v first");
log("up + locked; sitting out the idle window while locked…");
await new Promise((r) => setTimeout(r, IDLE + 30_000)); // locked-idle > IDLE: the killer precondition
log("locked-idle elapsed — unlocking now (old code died ~10s after this)");

const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(64))).toString("base64");
const t0 = Date.now();
const u = await fetch(`${B}/unlock`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ secret, nonce: crypto.randomUUID() }),
}).then((r) => r.json());
if (!u.token) throw new Error("unlock failed: " + JSON.stringify(u));
log(`unlock ok (+${Date.now() - t0}ms) — machine must stay awake now`);

const token = u.token;
const ws = new WebSocket(`ws://localhost:8080/ws?token=${token}`);
let slept = false;
ws.onmessage = (m) => {
  const e = JSON.parse(m.data);
  if (e.type === "sleep") { slept = true; log("ws event: sleep —", e.reason); }
};
await new Promise((r) => (ws.onopen = r));
log("ws open, silent");

const alive = () => fetch(`${B}/health`, { headers: { authorization: "Bearer " + token } }).then((r) => r.json()).catch(() => null);
const hasSleepEvt = async () => {
  const s = await fetch(`${B}/state`, { headers: { authorization: "Bearer " + token } }).then((r) => r.json());
  return (s.events || s.messages || s).some((e) => e.type === "sleep");
};

// Phase 1: for IDLE-30s past unlock, machine must be alive, no sleep event.
let ok = true;
const t1 = Date.now();
while (Date.now() - t1 < IDLE - 30_000) {
  await new Promise((r) => setTimeout(r, 10_000));
  const a = await alive();
  const s = await hasSleepEvt().catch(() => false);
  if (!a || s) { ok = false; log(`FAIL at +${Date.now() - t0}ms: alive=${!!a} sleepEvt=${s}`); break; }
}
if (ok) log(`survived to +${Date.now() - t0}ms with no sleep — bug fixed ✓ (gate counts from unlock)`);

// Phase 2: by unlock+IDLE+45s, the graceful sleep must have landed.
if (ok) {
  while (Date.now() - t0 < IDLE + 45_000) await new Promise((r) => setTimeout(r, 5_000));
  const a = await alive();
  log(`at +${Date.now() - t0}ms: alive=${!!a} wsSlept=${slept} — ${a ? "STILL ALIVE (FAIL?)" : "graceful exit ✓"}`);
}
process.exit(ok ? 0 : 1);
