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
const { uidShellOperations } = await import("/app/dist/guard/exec.js");
const { agentOwnedWriteOperations } = await import("/app/dist/guard/extension.js");

const DATA = process.env.DATA_DIR;
const AGENT = 1100;
const BROWSER = 1101;
const MODE = (p) => statSync(p).mode & 0o7777; // includes the sticky bit
const OWNER = (p) => statSync(p).uid;

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

// ── 2. The shell runs as the agent uid and hits the kernel wall ─────────
const ops = uidShellOperations(AGENT, AGENT);
const run = async (command) => {
  let out = "";
  const r = await ops.exec(command, join(DATA, "workspace"), {
    onData: (d) => (out += d.toString("utf-8")),
  });
  return { code: r.exitCode, out };
};

const denied = await run("cat ../log/events.jsonl");
assert.notEqual(denied.code, 0, "reading the system tree must fail");
assert.match(denied.out, /Permission denied|denied/, `the kernel says no: ${denied.out.slice(0, 200)}`);

const profileDenied = await run("cat ../browser/Default/Cookies 2>&1 || true");
assert.match(profileDenied.out, /Permission denied/, "the browser profile (cookies) is the browser uid's");
console.log("✓ shell as uid 1100: system tree and browser profile are EACCES");

// ── 3. The scrubbed env: platform secrets never reach the child ─────────
const env = await run("printenv");
assert.ok(!env.out.includes("container-secret-xyz"), "concierge secret must not reach the child");
assert.ok(!env.out.includes("container-key-xyz"), "inference key must not reach the child");
assert.match(env.out, /PATH=/, "the allowlist passes what shells need");
console.log("✓ child env scrubbed under the uid exec path");

// ── 4. The shell owns its workspace ─────────────────────────────────────
const wrote = await run("echo agent-made > mine.txt");
assert.equal(wrote.code, 0, `agent write must succeed: ${wrote.out}`);
assert.equal(OWNER(join(DATA, "workspace", "mine.txt")), AGENT);
console.log("✓ the agent works freely inside its workspace");

// ── 5. Tool-written files hand over to the agent uid ────────────────────
// The write tool executes in-process as root; without the ownership wrap
// its files would be root-only and the shell could not touch them.
const writeOps = agentOwnedWriteOperations();
await writeOps.mkdir(join(DATA, "workspace", "tool-made", "deep"));
await writeOps.writeFile(join(DATA, "workspace", "tool-made", "deep", "file.txt"), "tool-made");
assert.equal(OWNER(join(DATA, "workspace", "tool-made")), AGENT, "mkdir'd components hand over");
assert.equal(OWNER(join(DATA, "workspace", "tool-made", "deep", "file.txt")), AGENT, "tool-written files hand over");
const catBack = await run("cat tool-made/deep/file.txt");
assert.equal(catBack.code, 0, `the shell must read what the write tool created: ${catBack.out}`);
assert.match(catBack.out, /tool-made/);
console.log("✓ write-tool files are agent-owned (shell + tools interoperate)");

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
const { readFileSync, existsSync } = await import("node:fs");
const plant = await run("ln -s ../log link");
assert.equal(plant.code, 0, `planting a link in the workspace must succeed: ${plant.out}`);
// Dangling escape link: realpath ENOENTs but the write would CREATE the
// root-owned target (review-caught — the nastiest shape).
const dangle = await run("ln -s /etc/waddle-pwned dangling");
assert.equal(dangle.code, 0);
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

rmSync(DATA, { recursive: true, force: true });
console.log("guard-verify: all kernel-boundary properties hold");
