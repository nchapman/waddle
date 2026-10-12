/**
 * Container-level guard verification (slice 2): the kernel boundary only
 * exists where the gateway runs as root with the real uids — which is the
 * deployed image, not a dev host or CI runner. Run against the built image:
 *
 *   docker build -t waddle-guard-verify . \
 *     && docker run --rm -v "$PWD/scripts:/verify:ro" \
 *          -e CONCIERGE_SHARED_SECRET=container-secret-xyz \
 *          -e TINFOIL_API_KEY=container-key-xyz \
 *          waddle-guard-verify node /verify/guard-verify.mjs
 *
 * Exits non-zero on the first broken property. Plain asserts + console
 * output — it is evidence, not a test framework.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "waddle-guard-verify-"));
// The deployed tree lives at /app (WORKDIR); this script is mounted
// elsewhere, so import by absolute path.
const { enforcePlaypenInto } = await import("/app/dist/guard/playpen.js");
const { agentOwnedWriteOperations } = await import("/app/dist/guard/extension.js");
const { scrubEnv } = await import("/app/dist/guard/policy.js");

const DATA = process.env.DATA_DIR;
const AGENT = 1100;
const BROWSER = 1101;
const MODE = (p) => statSync(p).mode & 0o7777; // includes the sticky bit
const OWNER = (p) => statSync(p).uid;

/** Spawn argv directly as a uid — no shell anywhere (bash is gone). This
 *  is how the kernel wall is proven now: the property that used to ride
 *  the agent's shell still guards the workspace the file tools hand over
 *  to uid 1100, and any future uid-1100 execution seam. */
import { spawn } from "node:child_process";
const spawnAs = (uid, argv, cwd) =>
  new Promise((resolve) => {
    let out = "";
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      uid,
      gid: uid,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (d) => (out += d.toString("utf-8")));
    child.stderr?.on("data", (d) => (out += d.toString("utf-8")));
    child.once("error", (err) => resolve({ code: 1, out: String(err) }));
    child.once("close", (code) => resolve({ code: code ?? 1, out }));
  });

// ── 1. The playpen choreography with the REAL uids ──────────────────────
mkdirSync(join(DATA, "log"), { recursive: true });
writeFileSync(join(DATA, "log", "events.jsonl"), "sealed", { mode: 0o644 }); // what a loose restore carries
const report = enforcePlaypenInto(DATA, AGENT, BROWSER);
assert.equal(report.enforced, true, `enforcement must succeed: ${report.reason}`);
assert.equal(OWNER(join(DATA, "workspace")), AGENT, "workspace belongs to the agent uid");
assert.equal(MODE(join(DATA, "workspace")), 0o700);
assert.equal(OWNER(join(DATA, "browser")), BROWSER, "the profile belongs to the browser uid");
assert.equal(OWNER(join(DATA, "home")), BROWSER, "the browser HOME belongs to the browser uid");
assert.equal(MODE(join(DATA, "tmp")), 0o1777, "tmp is sticky shared scratch");
assert.equal(OWNER(join(DATA, "log")), 0, "the log stays root's");
assert.equal(MODE(join(DATA, "log")), 0o700);
assert.equal(MODE(join(DATA, "log", "events.jsonl")), 0o600, "a loose restore is re-tightened");
console.log("✓ playpen choreography (uids 1100/1101, root-only system tree)");

// ── 2. The kernel wall: uid 1100 cannot read the system tree ──────────
const denied = await spawnAs(AGENT, ["cat", join(DATA, "log", "events.jsonl")], join(DATA, "workspace"));
assert.notEqual(denied.code, 0, "reading the system tree must fail");
assert.match(denied.out, /Permission denied|denied/, `the kernel says no: ${denied.out.slice(0, 200)}`);

const profileDenied = await spawnAs(AGENT, ["cat", join(DATA, "browser", "Default", "Cookies")], join(DATA, "workspace"));
assert.match(profileDenied.out, /Permission denied/, "the browser profile (cookies) is the browser uid's");
console.log("✓ uid 1100: system tree and browser profile are EACCES");

// ── 3. The scrubbed env: platform secrets never leave the gateway ───────
// (scrubEnv is what the browser env and any future exec seam build on.)
const env = scrubEnv(process.env);
for (const [key, value] of Object.entries(env)) {
  assert.ok(!String(value).includes("container-secret-xyz"), `concierge secret leaked via ${key}`);
  assert.ok(!String(value).includes("container-key-xyz"), `inference key leaked via ${key}`);
}
assert.ok(env.PATH, "the allowlist passes what children need");
console.log("✓ scrubEnv: platform secrets stay in the gateway");

// ── 4. The agent uid owns and can work in its workspace ────────────────
const wrote = await spawnAs(AGENT, ["touch", "mine.txt"], join(DATA, "workspace"));
assert.equal(wrote.code, 0, `agent write must succeed: ${wrote.out}`);
assert.equal(OWNER(join(DATA, "workspace", "mine.txt")), AGENT);
console.log("✓ the agent uid works freely inside its workspace");

// ── 5. Tool-written files hand over to the agent uid ────────────────────
// The write tool executes in-process as root; without the ownership wrap
// its files would be root-only and the shell could not touch them.
const writeOps = agentOwnedWriteOperations();
await writeOps.mkdir(join(DATA, "workspace", "tool-made", "deep"));
await writeOps.writeFile(join(DATA, "workspace", "tool-made", "deep", "file.txt"), "tool-made");
assert.equal(OWNER(join(DATA, "workspace", "tool-made")), AGENT, "mkdir'd components hand over");
assert.equal(OWNER(join(DATA, "workspace", "tool-made", "deep", "file.txt")), AGENT, "tool-written files hand over");
const catBack = await spawnAs(AGENT, ["cat", "tool-made/deep/file.txt"], join(DATA, "workspace"));
assert.equal(catBack.code, 0, `uid 1100 must read what the write tool created: ${catBack.out}`);
assert.match(catBack.out, /tool-made/);
console.log("✓ write-tool files are agent-owned (tools + uid interoperate)");

// ── 6. Chromium boots as the browser uid and owns its tree ─────────
// The review-caught gap: nothing exercised the browser uid. The playpen
// pre-creates the XDG dirs; the lazy browser-boot path must also hand
// them over. A real boot is the proof.
const { ensureBrowser, stopBrowser } = await import("/app/dist/browser.js");
await ensureBrowser();
try {
  const assertTree = (p) => {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const full = join(p, e.name);
      if (e.isDirectory()) {
        assert.equal(OWNER(full), BROWSER, `browser tree must be uid ${BROWSER}: ${full}`);
        assertTree(full);
      } else if (e.isFile()) {
        assert.equal(OWNER(full), BROWSER, `browser file must be uid ${BROWSER}: ${full}`);
      }
    }
  };
  assertTree(join(DATA, "browser"));
  assert.equal(OWNER(join(DATA, "home", ".config")), BROWSER, "XDG config dir is the browser's");
  assert.equal(OWNER(join(DATA, "home", ".cache")), BROWSER, "XDG cache dir is the browser's");
} finally {
  await stopBrowser();
}
console.log("✓ Chromium boots as uid 1101 and owns its profile + XDG dirs");

// ── 7. Symlink attacks on the file tools are refused ───────────────
// The shell (uid 1100) plants a link in its own workspace; the root
// file tools must neither write through it nor hand its target over.
const { readFileSync, existsSync, symlinkSync } = await import("node:fs");
symlinkSync(join(DATA, "log"), join(DATA, "workspace", "link"));
// Dangling escape link: realpath ENOENTs but the write would CREATE the
// root-owned target (review-caught — the nastiest shape).
symlinkSync("/etc/waddle-pwned", join(DATA, "workspace", "dangling"));
await assert.rejects(
  () => writeOps.writeFile(join(DATA, "workspace", "link", "events.jsonl"), "evil"),
  /outside the workspace/,
  "write through a planted link must be refused",
);
await assert.rejects(
  () => writeOps.mkdir(join(DATA, "workspace", "link", "sub")),
  /outside the workspace/,
  "mkdir through a planted link must be refused",
);
assert.equal(readFileSync(join(DATA, "log", "events.jsonl"), "utf-8"), "sealed", "the system tree is untouched");
await assert.rejects(
  () => writeOps.writeFile(join(DATA, "workspace", "dangling"), "evil"),
  /outside the workspace/,
  "a write through a dangling escape link must be refused",
);
assert.equal(existsSync("/etc/waddle-pwned"), false, "no root-owned file created outside the container boundary");
const { ownForAgent } = await import("/app/dist/guard/extension.js");
await ownForAgent(join(DATA, "workspace", "link", "x"));
assert.equal(OWNER(join(DATA, "log")), 0, "the handoff must not chown through the link");
// A symlinked workspace root: every file-tool write must be refused.
const { renameSync, symlinkSync: sym } = await import("node:fs");
renameSync(join(DATA, "workspace"), join(DATA, "workspace.real"));
sym("/etc", join(DATA, "workspace"));
try {
  await assert.rejects(
    () => writeOps.writeFile(join(DATA, "workspace", "pwned.txt"), "evil"),
    /workspace root itself is a symlink/,
    "writes through a symlinked workspace root must be refused",
  );
} finally {
  rmSync(join(DATA, "workspace")); // the link only
  renameSync(join(DATA, "workspace.real"), join(DATA, "workspace"));
}
console.log("✓ planted symlinks: no writes, no handoff, system tree intact");

// ── 8. Codemode executes in the container (QuickJS sandbox loads) ──────
// bash is gone; scripts are the agent's only computation. Prove the
// sandbox actually runs in this image — a pure-computation script (no
// tools; those need a model-driven turn's pipeline, pi's own contract).
const { createCodemodeToolDefinition } = await import(
  "/app/node_modules/@earendil-works/pi-coding-agent/dist/extensions/codemode/tool.js"
);
const codemodeTool = createCodemodeToolDefinition({
  appendEntry: () => undefined,
  getToolNamespace: () => undefined,
  getToolGuidelines: () => new Map(),
  getMode: () => "on",
  getInlineBudget: () => undefined,
});
const scriptResult = await codemodeTool.execute(
  "verify-1",
  { code: 'return "sandbox says " + (6 * 7);' },
  undefined,
  undefined,
  undefined,
);
const scriptText = scriptResult.content.map((c) => (c.type === "text" ? c.text : "")).join("");
assert.match(scriptText, /sandbox says 42/, `QuickJS executes in the container: ${scriptText.slice(0, 300)}`);
console.log("✓ codemode: the QuickJS sandbox executes in-container");

// ── 9. Arm hygiene (slice 4): the escrow gate in the deployed shape ──
// The container is the one place the playpen verdict runs as ROOT with
// the real uids (dev tests can never exercise the enforced branch), and
// the boot secrets sit in the registry the way index.ts registers them.
const { checkPlaypenForArm, checkSnapshotHygiene } = await import("/app/dist/guard/arm.js");
const { createArchive } = await import("/app/dist/archive.js");
const { registerBootSecrets } = await import("/app/dist/guard/policy.js");
registerBootSecrets(process.env);

// A properly enforced root machine passes the playpen gate — this script
// ran the full choreography in section 1, so the report says enforced.
const pen = checkPlaypenForArm();
assert.equal(pen.ok, true, `enforced machine must arm: ${JSON.stringify(pen)}`);
console.log("✓ arm hygiene: an enforced root machine passes the playpen gate");

// A clean tree passes the snapshot gate.
mkdirSync(join(DATA, "workspace"), { recursive: true });
writeFileSync(join(DATA, "workspace", "note.txt"), "context only\n");
assert.deepEqual(checkSnapshotHygiene(createArchive(true).body), { ok: true });
console.log("✓ arm hygiene: a clean snapshot passes");

// A plaintext platform secret in a workspace file refuses — and names the
// file, never the value. Only meaningful with the secret env the run
// instructions pass; without it this property skips (registerSecret drops
// null/undefined, so there would be nothing to find — not a failure).
if (process.env.CONCIERGE_SHARED_SECRET) {
  writeFileSync(join(DATA, "workspace", "leak.txt"), `leaked ${process.env.CONCIERGE_SHARED_SECRET}\n`);
  const dirty = checkSnapshotHygiene(createArchive(true).body);
  assert.equal(dirty.ok, false);
  assert.match(dirty.reason, /"concierge-shared-secret" in snapshot at workspace\/leak\.txt/);
  rmSync(join(DATA, "workspace", "leak.txt"));
  console.log("✓ arm hygiene: a plaintext secret in the snapshot refuses, naming the file");
} else {
  console.log("– arm hygiene: secret-scan property skipped (no CONCIERGE_SHARED_SECRET; pass the -e vars to exercise it)");
}

// The browser profile must never ride the escrow — the full/shelf variant
// (createArchive(false)) is the standing regression shape for a wrong flag.
mkdirSync(join(DATA, "browser", "Default"), { recursive: true });
writeFileSync(join(DATA, "browser", "Default", "Cookies"), "bearer tokens");
const browsered = checkSnapshotHygiene(createArchive(false).body);
assert.equal(browsered.ok, false);
assert.match(browsered.reason, /browser profile in snapshot: browser\//); // first member = the dir entry
console.log("✓ arm hygiene: the browser profile refuses (wrong-variant regression caught)");

// GNU tar's long-name dialect ('L' members) — this container is the only
// place that branch runs (macOS bsdtar uses pax records instead).
const { walkTar } = await import("/app/dist/guard/arm.js");
const { decodeArchive } = await import("/app/dist/archive.js");
const LONG = `${"g".repeat(140)}.txt`;
writeFileSync(join(DATA, "browser", "Default", LONG), "x");
const gnuNames = walkTar(decodeArchive(createArchive(false).body)).map((m) => m.name);
assert.ok(
  gnuNames.some((n) => n === `browser/Default/${LONG}`),
  `GNU longname resolved in full: ${gnuNames.join(",")}`,
);
console.log("✓ arm hygiene: GNU long-name members walk in full");

rmSync(DATA, { recursive: true, force: true });
console.log("guard-verify: all kernel-boundary properties hold");
