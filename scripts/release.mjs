#!/usr/bin/env node
// The waddle release train — the full AGENTS.md ceremony, one command.
//
//   node scripts/release.mjs --dry-run     # preflight + plan, no side effects
//   node scripts/release.mjs               # the whole train (asks before platform writes)
//   node scripts/release.mjs --yes         # ... without asking (CI-ish; you watched dry-run first)
//   node scripts/release.mjs --skip-tests  # trust a recent local run
//
// Encodes, in order (AGENTS.md "deploy ceremony"):
//   preflight  clean tree, .env.local, tinfoil CLI, checks+tests, /tmp config clones
//   bump       version bump both package.jsons (python re.sub), commit, push
//   build      buildx push waddle + concierge (repo-root context both)
//   pin        digest pins + STANDBY_CONFIG_TAG treadmill in /tmp config repos
//              (python re.sub — sed once shipped a broken release), mirrored
//              into config/ in this repo, commit+push
//   release    gh workflow run tinfoil-release.yml per repo (NEVER gh release
//              create — the platform 500s on it), poll to assets attached
//   platform   drain Running standbys, update waddle + waddle-concierge
//              (update persists the saved tag — deploy does not), poll /health
//   smoke      pnpm smoke:live (TOFU re-pin included)
//
// Every step checks its own precondition and skips if already done, so a
// re-run after a flake picks up where the train stopped.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WADDLE_CONFIG_DIR = "/tmp/waddle-config";
const CONCIERGE_CONFIG_DIR = "/tmp/waddle-concierge-config";
const DOMAIN_BASE = "ddg-waddle.containers.tinfoil.dev";
const HEALTH_POLL_MS = 5 * 60 * 1000; // deploy ~75-95s; cert stalls measured 5.4min

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const YES = args.includes("--yes");
const SKIP_TESTS = args.includes("--skip-tests");

let stepFailed = false;
function log(msg) { console.log(`[release] ${msg}`); }
function die(msg) { console.error(`[release] FATAL: ${msg}`); process.exit(1); }

function sh(cmd, argv = [], opts = {}) {
  // Run and capture; never let a failing step look like success.
  try {
    return execFileSync(cmd, argv, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts })
      .toString().trim();
  } catch (e) {
    if (opts.allowFail) return null;
    die(`command failed: ${cmd} ${JSON.stringify(argv)}\n${e.stderr || e.message}`);
  }
}
function shOut(cmd, argv, opts = {}) { return sh(cmd, argv, opts); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadEnvLocal() {
  const p = join(ROOT, ".env.local");
  if (!existsSync(p)) die(".env.local missing — the tinfoil CLI needs TINFOIL_API_KEY from it");
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  if (!process.env.TINFOIL_API_KEY) die("TINFOIL_API_KEY not in .env.local");
}

function bumpVersion(pkgPath, next) {
  // python re.sub for JSON too — one editing discipline, and it refuses to
  // silently no-op (count check) the way a text replace can.
  sh("python3", ["-c", `
import json, re, sys
p = ${JSON.stringify(pkgPath)}
s = open(p).read()
s2, n = re.subn(r'"version":\\s*"[^"]+"', '"version": "${next}"', s, count=1)
assert n == 1, "version field not found in " + p
open(p, "w").write(s2)
`]);
}

function pinYaml(yamlPath, replacements) {
  // replacements: {pattern: replacement} — applied with python re.sub, count=1.
  // Never sed: it ate a closing quote once and shipped v0.0.42 broken.
  sh("python3", ["-c", `
import re, sys
p = ${JSON.stringify(yamlPath)}
s = open(p).read()
for pat, repl in ${JSON.stringify(replacements)}.items():
    s, n = re.subn(pat, repl, s, count=1)
    assert n == 1, "pattern not found in %s: %s" % (p, pat)
open(p, "w").write(s)
`]);
}

function gitStatus(dir = ROOT) { return shOut("git", ["status", "--porcelain"], { cwd: dir }); }
async function main() {
  log(`mode: ${DRY ? "DRY RUN (no side effects)" : YES ? "full train, no prompts" : "full train (prompting)"}`);
  loadEnvLocal();

  // ---------- preflight ----------
  const dirty = gitStatus();
  if (!DRY) {
    if (dirty) die(`working tree dirty:\n${dirty}\ncommit or stash first — the train commits version bumps itself`);
  } else if (dirty) log(`preflight: tree dirty (allowed in dry-run):\n${dirty.split("\n").slice(0, 5).join("\n")}`);

  shOut("node", ["--version"]);
  const tinfoil = join(process.env.HOME, ".local/bin/tinfoil");
  if (!existsSync(tinfoil)) die(`tinfoil CLI missing at ${tinfoil}`);
  shOut(tinfoil, ["container", "list", "-o", "json"], { allowFail: true }) ?? die("tinfoil container list failed — API key / platform reachability");

  if (!SKIP_TESTS) {
    log("checks: root pnpm check");
    shOut("pnpm", ["check"]);
    log("checks: server pnpm check + full test suite");
    shOut("pnpm", ["check"], { cwd: join(ROOT, "server") });
    shOut("pnpm", ["test"], { cwd: join(ROOT, "server") });
  } else log("checks: SKIPPED (--skip-tests)");

  // /tmp clones die on reboot — re-create them rather than failing.
  for (const [dir, url] of [[WADDLE_CONFIG_DIR, "git@github.com:nchapman/waddle-config.git"],
                            [CONCIERGE_CONFIG_DIR, "git@github.com:nchapman/waddle-concierge-config.git"]]) {
    if (!existsSync(dir)) {
      log(`config clone missing (${dir}) — cloning`);
      if (!DRY) shOut("git", ["clone", url, dir]);
    }
    if (!DRY && gitStatus(dir)) die(`${dir} dirty — the clones are sacred state, refusing to touch them:\n${gitStatus(dir)}`);
    if (!DRY) shOut("git", ["pull", "--ff-only"], { cwd: dir, allowFail: true });
  }

  // ---------- versions ----------
  const waddlePkg = JSON.parse(readFileSync(join(ROOT, "server/package.json"), "utf8"));
  const conciergePkg = JSON.parse(readFileSync(join(ROOT, "concierge/package.json"), "utf8"));
  const nextPatch = (v) => {
    const m = v.match(/^(\d+)\.(\d+)\.(\d+)$/);
    return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
  };
  // RESUME: a train that died after its bump commit must not bump AGAIN on
  // re-run (live-caught: died at the asset wait, re-run shipped vN+1 with
  // nothing new). If HEAD is this train's own bump commit and the package
  // versions match it, the CURRENT versions are the target — continue the
  // train (build/pin/release are each already-done-checkable).
  const head = shOut("git", ["log", "-1", "--format=%s"]);
  // Deaths after the bump land on EITHER train commit (bump, or the
  // mirror commit that follows the pins) — match both (review-caught:
  // the asset-wait death the guard was written for sits on the mirror
  // commit, where a bump-only match misses it and double-bumps).
  const bumpResume =
    head?.match(/^Bump versions: server v([\d.]+), concierge v([\d.]+)$/) ??
    head?.match(/^Release train: waddle v([\d.]+) \+ concierge v([\d.]+) config mirrors$/);
  const resuming = bumpResume && bumpResume[1] === waddlePkg.version && bumpResume[2] === conciergePkg.version;
  const waddleNext = argValue("--waddle") || (resuming ? waddlePkg.version : nextPatch(waddlePkg.version));
  const conciergeNext = argValue("--concierge") || (resuming ? conciergePkg.version : nextPatch(conciergePkg.version));
  if (!/^\d+\.\d+\.\d+$/.test(waddleNext) || !/^\d+\.\d+\.\d+$/.test(conciergeNext)) die(`bad version(s): ${waddleNext} / ${conciergeNext}`);
  log(`train: waddle v${waddlePkg.version} → v${waddleNext}, concierge v${conciergePkg.version} → v${conciergeNext}${resuming ? " (RESUMING a died-after-bump train — not bumping again)" : ""}`);
  log(`treadmill reminder: every waddle release bumps the concierge too (STANDBY_CONFIG_TAG → v${waddleNext})`);

  // ---------- the plan (dry-run stops here after printing it) ----------
  const plan = [
    `bump:    server/package.json → v${waddleNext}, concierge/package.json → v${conciergeNext}; commit "Bump versions: …"; push origin main`,
    `build:   docker buildx build --platform linux/amd64 -t ghcr.io/nchapman/waddle:v${waddleNext} --push .`,
    `build:   docker buildx build --platform linux/amd64 -f concierge/Dockerfile -t ghcr.io/nchapman/waddle-concierge:v${conciergeNext} --push . (repo-root context)`,
    `pin:     ${WADDLE_CONFIG_DIR}: waddle image → digest(v${waddleNext})   [python re.sub]`,
    `pin:     ${CONCIERGE_CONFIG_DIR}: concierge image → digest(v${conciergeNext}), STANDBY_CONFIG_TAG → v${waddleNext}`,
    `mirror:  config/tinfoil-config.yml + config/concierge-tinfoil-config.yml in this repo; commit+push both config repos + this repo`,
    `release: gh workflow run tinfoil-release.yml -f version=v${waddleNext} (waddle-config) and -f version=v${conciergeNext} (concierge-config); poll until tinfoil-deployment.json + tinfoil.hash attached`,
    `drain:   delete Running waddle-standby-* (pool memory dies with a concierge restart — v0.4.9+ cold-starts empty)`,
    `update:  tinfoil container update <main machine> --tag v${waddleNext} --yes  (update, not deploy — it persists the saved tag for the wake path)`,
    `update:  tinfoil container update waddle-concierge --tag v${conciergeNext} --yes`,
    `health:  poll machine + concierge /health until versions match (timeout ${HEALTH_POLL_MS / 1000}s)`,
    `smoke:   pnpm smoke:live (attestation assert + TOFU re-pin)`,
  ];
  for (const p of plan) console.log(`  ${p}`);

  // Mirror-consistency check even in dry-run: repo config must equal /tmp clone now.
  const mirrorOk =
    readFileSync(join(ROOT, "config/tinfoil-config.yml"), "utf8") === readFileSync(join(WADDLE_CONFIG_DIR, "tinfoil-config.yml"), "utf8") &&
    readFileSync(join(ROOT, "config/concierge-tinfoil-config.yml"), "utf8") === readFileSync(join(CONCIERGE_CONFIG_DIR, "tinfoil-config.yml"), "utf8");
  log(`mirror consistency (repo config/ vs /tmp clones): ${mirrorOk ? "in sync" : "OUT OF SYNC — the train will rewrite both to match"}`);

  if (DRY) { log("dry run complete — no side effects"); return; }

  if (!YES) {
    const { createInterface } = await import("node:readline");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((r) => rl.question("[release] run the full train? (y/N) ", r));
    rl.close();
    if (answer.toLowerCase() !== "y") die("aborted");
  }

  // ---------- bump ----------
  if (waddlePkg.version !== waddleNext) {
    log(`bump: server v${waddleNext}, concierge v${conciergeNext}`);
    bumpVersion(join(ROOT, "server/package.json"), waddleNext);
    bumpVersion(join(ROOT, "concierge/package.json"), conciergeNext);
    shOut("git", ["add", "server/package.json", "concierge/package.json"]);
    shOut("git", ["commit", "-m", `Bump versions: server v${waddleNext}, concierge v${conciergeNext}`]);
    shOut("git", ["push", "origin", "main"]);
  } else log("bump: already at target versions — skipping");

  // ---------- build ----------
  const waddleRef = `ghcr.io/nchapman/waddle:v${waddleNext}`;
  const conciergeRef = `ghcr.io/nchapman/waddle-concierge:v${conciergeNext}`;
  let waddleDigest = digestOf(waddleRef);
  if (!waddleDigest) {
    log(`build: waddle v${waddleNext}`);
    shOut("docker", ["buildx", "build", "--platform", "linux/amd64", "-t", waddleRef, "--push", "."]);
    waddleDigest = digestOf(waddleRef);
  } else log(`build: waddle v${waddleNext} already pushed (${short(waddleDigest)})`);
  let conciergeDigest = digestOf(conciergeRef);
  if (!conciergeDigest) {
    log(`build: concierge v${conciergeNext}`);
    shOut("docker", ["buildx", "build", "--platform", "linux/amd64", "-f", "concierge/Dockerfile", "-t", conciergeRef, "--push", "."]);
    conciergeDigest = digestOf(conciergeRef);
  } else log(`build: concierge v${conciergeNext} already pushed (${short(conciergeDigest)})`);

  // ---------- pin ----------
  const waddleYaml = join(WADDLE_CONFIG_DIR, "tinfoil-config.yml");
  const conciergeYaml = join(CONCIERGE_CONFIG_DIR, "tinfoil-config.yml");
  if (!readFileSync(waddleYaml, "utf8").includes(waddleDigest)) {
    log(`pin: waddle-config → ${short(waddleDigest)}`);
    pinYaml(waddleYaml, { "ghcr\\.io/nchapman/waddle@sha256:[0-9a-f]+": `ghcr.io/nchapman/waddle@${waddleDigest}` });
  } else log("pin: waddle digest already pinned");
  const conciergeYamlNow = readFileSync(conciergeYaml, "utf8");
  if (!conciergeYamlNow.includes(conciergeDigest) || !conciergeYamlNow.includes(`STANDBY_CONFIG_TAG: v${waddleNext}`)) {
    log(`pin: concierge-config → ${short(conciergeDigest)} + STANDBY_CONFIG_TAG v${waddleNext}`);
    pinYaml(conciergeYaml, {
      "ghcr\\.io/nchapman/waddle-concierge@sha256:[0-9a-f]+": `ghcr.io/nchapman/waddle-concierge@${conciergeDigest}`,
      "STANDBY_CONFIG_TAG:\\s*v\\d+\\.\\d+\\.\\d+": `STANDBY_CONFIG_TAG: v${waddleNext}`,
    });
  } else log("pin: concierge digest + treadmill already pinned");

  copyFileSyncSafe(waddleYaml, join(ROOT, "config/tinfoil-config.yml"));
  copyFileSyncSafe(conciergeYaml, join(ROOT, "config/concierge-tinfoil-config.yml"));
  shOut("git", ["-C", WADDLE_CONFIG_DIR, "add", "-A"]);
  shOut("git", ["-C", WADDLE_CONFIG_DIR, "commit", "-m", `Pin waddle v${waddleNext} (${short(waddleDigest)})`], { allowFail: true }) ?? null;
  shOut("git", ["-C", WADDLE_CONFIG_DIR, "push"]);
  shOut("git", ["-C", CONCIERGE_CONFIG_DIR, "add", "-A"]);
  shOut("git", ["-C", CONCIERGE_CONFIG_DIR, "commit", "-m", `Pin concierge v${conciergeNext} (${short(conciergeDigest)}); STANDBY_CONFIG_TAG v${waddleNext}`], { allowFail: true }) ?? null;
  shOut("git", ["-C", CONCIERGE_CONFIG_DIR, "push"]);
  shOut("git", ["add", "config/"]);
  shOut("git", ["commit", "-m", `Release train: waddle v${waddleNext} + concierge v${conciergeNext} config mirrors`], { allowFail: true }) ?? null;
  shOut("git", ["push", "origin", "main"], { allowFail: true });

  // ---------- release (workflow, never manual gh release create) ----------
  await ensureRelease(WADDLE_CONFIG_DIR, `v${waddleNext}`);
  await ensureRelease(CONCIERGE_CONFIG_DIR, `v${conciergeNext}`);

  // ---------- platform ----------
  // Drain standbys BEFORE the concierge restart: a restart orphans pool
  // memory and Running stock adopts as FOREIGN, burning CLAIM_GRACE_MS.
  const list = JSON.parse(shOut(tinfoil, ["container", "list", "-o", "json"]));
  const containers = Array.isArray(list) ? list : (list.containers ?? list.data ?? []);
  for (const c of containers) {
    if (/^waddle-standby-/.test(c.name) && c.status === "running") {
      log(`drain: delete ${c.name} (running standby)`);
      shOut(tinfoil, ["container", "delete", c.name, "--yes"]);
    }
  }
  const main = containers.find((c) => /^waddle-u/.test(c.name)) ?? containers.find((c) => c.name === "waddle");
  if (!main) die("no main machine found (expected a waddle-u<hash> cattle name)");
  log(`update: ${main.name} → v${waddleNext}`);
  shOut(tinfoil, ["container", "update", main.name, "--tag", `v${waddleNext}`, "--yes"]);
  log("update: waddle-concierge → v" + conciergeNext);
  shOut(tinfoil, ["container", "update", "waddle-concierge", "--tag", `v${conciergeNext}`, "--yes"]);

  await pollHealth(`${main.name}.${DOMAIN_BASE}`, waddleNext);
  await pollHealth(`waddle-concierge.${DOMAIN_BASE}`, conciergeNext);

  // ---------- smoke ----------
  log("smoke: pnpm smoke:live (TOFU re-pin)");
  shOut("pnpm", ["smoke:live"]);
  log(`DONE — waddle v${waddleNext} + concierge v${conciergeNext} live, smoked, pinned`);
}

function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}
function short(d) { return d.slice(0, 19) + "…"; }
function digestOf(ref) {
  const out = shOut("docker", ["buildx", "imagetools", "inspect", ref, "--format", "{{.Manifest.Digest}}"], { allowFail: true });
  return out && out.startsWith("sha256:") ? out : null;
}
function copyFileSyncSafe(from, to) { writeFileSync(to, readFileSync(from, "utf8")); }

async function ensureRelease(repoDir, tag) {
  const repo = repoDir.endsWith("waddle-config") ? "nchapman/waddle-config" : "nchapman/waddle-concierge-config";
  const assets = shOut("gh", ["release", "view", tag, "-R", repo, "--json", "assets", "--jq", ".assets[].name"], { allowFail: true });
  if (assets && assets.includes("tinfoil.hash") && assets.includes("tinfoil-deployment.json")) {
    log(`release: ${repo} ${tag} already published with platform assets`);
    return;
  }
  log(`release: gh workflow run tinfoil-release.yml -f version=${tag} (${repo})`);
  shOut("gh", ["workflow", "run", "tinfoil-release.yml", "-f", `version=${tag}`, "-R", repo]);
  const deadline = Date.now() + 15 * 60 * 1000;
  const assetsAttached = () => {
    const a = shOut("gh", ["release", "view", tag, "-R", repo, "--json", "assets", "--jq", ".assets[].name"], { allowFail: true });
    return a && a.includes("tinfoil.hash") && a.includes("tinfoil-deployment.json") ? a : null;
  };
  while (Date.now() < deadline) {
    await sleep(30_000);
    // TWO workflows own a release: "Release vX" creates it, then an
    // auto-triggered "Publish release vX" attaches the platform assets
    // (tinfoil-deployment.json + tinfoil.hash). Success of the first is
    // NOT completion — the ASSETS are (train died here once, live-caught).
    const run = shOut("gh", ["run", "list", "-R", repo, "--workflow", "tinfoil-release.yml", "--limit", "1", "--json", "status,conclusion,displayTitle"], { allowFail: true });
    if (run) {
      const j = JSON.parse(run)[0];
      log(`release: ${repo} ${j.displayTitle}: ${j.status}${j.conclusion ? ` (${j.conclusion})` : ""}`);
      if (j.status === "completed" && j.conclusion !== "success") die(`release workflow failed for ${repo} ${tag} — see gh run view`);
    }
    const assets = assetsAttached();
    if (assets) { log(`release: ${repo} ${tag} published (assets: ${assets.split("\n").join(", ")})`); return; }
  }
  die(`release assets never attached for ${repo} ${tag} (Release workflow done? Publish workflow stuck? — gh run view -R ${repo})`);
}

async function pollHealth(host, version) {
  const deadline = Date.now() + HEALTH_POLL_MS;
  while (Date.now() < deadline) {
    const out = shOut("curl", ["-s", "--max-time", "10", `https://${host}/health`], { allowFail: true });
    if (out) {
      try {
        const j = JSON.parse(out);
        if (j.version === version) { log(`health: ${host} serving v${version} ✓`); return; }
        log(`health: ${host} at v${j.version}, waiting for v${version}…`);
      } catch { log(`health: ${host} not serving JSON yet…`); }
    } else log(`health: ${host} unreachable (DNS/edge lag)…`);
    await sleep(15_000);
  }
  die(`health: ${host} never served v${version}`);
}

main().catch((e) => die(e.stack ?? e));
