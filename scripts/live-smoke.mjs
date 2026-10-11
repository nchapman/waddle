#!/usr/bin/env node
/**
 * live-smoke — the post-ceremony production smoke (fast + repeatable).
 *
 * Verifies the whole wire stack against the live deployment:
 *   1. Concierge /health — service, backend, version (tinfoil, expected tag)
 *   2. Machine /health   — version + locked:true (polls while a deploy settles)
 *   3. The real client (vite, live env, port 5173 — the concierge's allowed
 *      origin) driven in Chrome via Playwright:
 *        - discovery is stubbed at /boot ONLY (the smoke has no betterbase
 *          session; everything downstream is real)
 *        - REAL attestation against the machine + release measurement
 *        - TOFU: first run pins silently; every later release run hits the
 *          "code fingerprint changed" block — the script asserts the shown
 *          release tag matches expectations and performs the re-pin
 *        - reaches the Attested screen and opens the unlock form
 *
 * Usage:  pnpm smoke:live [-- --expect 0.0.53] [-- --instance waddle-u…] [--headed]
 * Env:    WADDLE_INSTANCE pins the target (else discovered via `tinfoil
 *         container list`, needs TINFOIL_ADMIN_KEY — sourced from .env.local).
 * Profile: .pi/evidence/smoke-profile (persistent — it is what makes later
 *         runs exercise the pin-conflict path). Screenshot per run alongside.
 */
import { chromium } from "playwright";
import { spawn, execFile } from "node:child_process";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const EXPECT_SERVER = arg("expect", JSON.parse(readFileSync(join(ROOT, "server/package.json"))).version);
const EXPECT_CONCIERGE = arg("expect-concierge", JSON.parse(readFileSync(join(ROOT, "concierge/package.json"))).version);
const HEADED = process.argv.includes("--headed");
const CONCIERGE_URL = process.env.WADDLE_CONCIERGE_URL ?? "https://waddle-concierge.ddg-waddle.containers.tinfoil.dev";
const ZONE = new URL(CONCIERGE_URL).hostname.split(".").slice(1).join("."); // ddg-waddle.containers.tinfoil.dev
const CLIENT_PORT = 5173; // the ONLY origin the concierge's CORS allows
const PROFILE = join(ROOT, ".pi/evidence/smoke-profile");
const EVIDENCE = join(ROOT, ".pi/evidence");

const log = (...a) => console.log(`[smoke]`, ...a);
const btoaUrl = (s) => Buffer.from(s).toString("base64url");
const die = (msg) => {
  console.error(`[smoke] FAIL — ${msg}`);
  process.exitCode = 1;
};

/** TINFOIL_ADMIN_KEY from env or the repo's .env.local (never printed). */
function adminKey() {
  if (process.env.TINFOIL_ADMIN_KEY) return process.env.TINFOIL_ADMIN_KEY;
  try {
    const m = /^TINFOIL_ADMIN_KEY=(.+)$/m.exec(readFileSync(join(ROOT, ".env.local"), "utf8"));
    if (m) return m[1].trim();
  } catch {}
  return "";
}

/** The user machine (waddle-u…) — from --instance/WADDLE_INSTANCE or the platform list. */
async function discoverInstance() {
  const named = arg("instance", process.env.WADDLE_INSTANCE ?? "");
  if (named) return named;
  const key = adminKey();
  if (!key) throw new Error("no WADDLE_INSTANCE and no TINFOIL_ADMIN_KEY to discover it");
  const out = await new Promise((resolve, reject) =>
    execFile(join(process.env.HOME, ".local/bin/tinfoil"), ["container", "list"], {
      env: { ...process.env, TINFOIL_ADMIN_KEY: key },
      timeout: 60_000,
    }, (e, stdout) => (e ? reject(e) : resolve(stdout))),
  );
  const machines = out.split("\n").map((l) => l.trim().split(/\s+/)[0]).filter((n) => /^waddle-u/.test(n));
  if (machines.length !== 1) throw new Error(`expected exactly one user machine, found: ${machines.join(", ") || "none"}`);
  return machines[0];
}

async function fetchJson(url, timeoutMs = 15_000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** Poll until fn() resolves non-null (or throw after budget). */
async function until(budgetMs, everyMs, fn, label) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

async function main() {
  mkdirSync(EVIDENCE, { recursive: true });
  log(`expect: server v${EXPECT_SERVER}, concierge v${EXPECT_CONCIERGE}`);

  // ── 1. Concierge ─────────────────────────────────────────────────────
  const concierge = await until(30_000, 3_000, async () => {
    const { body } = await fetchJson(`${CONCIERGE_URL}/health`);
    return body?.service === "waddle-concierge" ? body : null;
  }, "concierge /health");
  if (concierge.version !== EXPECT_CONCIERGE) throw new Error(`concierge on v${concierge.version}, expected v${EXPECT_CONCIERGE}`);
  if (concierge.backend !== "tinfoil") throw new Error(`concierge backend=${concierge.backend}`);
  log(`concierge v${concierge.version} ✓ (pool: ${JSON.stringify(concierge.pool)})`);

  // ── 2. Machine ────────────────────────────────────────────────────────
  const instance = await discoverInstance();
  const machineUrl = `https://${instance}.${ZONE}`;
  log(`machine: ${machineUrl}`);
  const machine = await until(240_000, 5_000, async () => {
    const { body } = await fetchJson(`${machineUrl}/health`);
    return body?.service === "waddle-server" ? body : null;
  }, `machine /health (deploy settling?)`);
  if (machine.version !== EXPECT_SERVER) throw new Error(`machine on v${machine.version}, expected v${EXPECT_SERVER}`);
  log(`machine v${machine.version} ✓ locked=${machine.locked} storage=${machine.storage}`);
  if (!machine.locked) log(`  NOTE: machine unlocked (a live session?) — the smoke continues; TOFU still applies`);

  // ── 3. Client (vite, live env) ────────────────────────────────────────
  const vite = spawn("pnpm", ["--filter", "@waddle/client", "exec", "vite", "--port", String(CLIENT_PORT), "--strictPort"], {
    cwd: ROOT,
    env: {
      ...process.env,
      // Live build config — process env outranks the client's .env files.
      VITE_DEV: "0",
      VITE_CONFIG_REPO: "nchapman/waddle-config",
      VITE_CONCIERGE_URL: CONCIERGE_URL,
      VITE_BETTERBASE_DOMAIN: "betterbase.dev",
      VITE_BETTERBASE_SYNC_URL_ENCLAVE: "https://sync.betterbase.dev/api/v1",
      VITE_BETTERBASE_CLIENT_ID: "d096d76d-d066-4ac9-956c-ad3f35c57450",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const viteErr = [];
  vite.stderr.on("data", (d) => viteErr.push(String(d)));
  try {
    await until(30_000, 500, async () => {
      const { status } = await fetchJson(`http://localhost:${CLIENT_PORT}/`, 2_000).catch(() => ({ status: 0 }));
      return status === 200 || null;
    }, `vite on :${CLIENT_PORT} (is a dev server already on it? stop it first)`);
    await new Promise((r) => setTimeout(r, 2_500)); // let the dep optimizer settle before first page load

    // ── 4. Chrome: attest, TOFU(-re)pin, unlock form ────────────────────
    const ctx = await chromium.launchPersistentContext(PROFILE, {
      channel: "chrome", // the installed Google Chrome — no browser download
      headless: !HEADED,
    });
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    const consoleErrs = [];
    page.on("pageerror", (e) => consoleErrs.push(String(e)));
    page.on("console", (m) => {
      if (m.type() === "error" || m.type() === "warning") consoleErrs.push(`[${m.type()}] ${m.text()}`);
    });
    try {
      // Discovery seam, two layers deep (the app refuses to /boot without a
      // betterbase session, client-side, and the smoke owns no bb login):
      //   1. a minimal fake bb session — no key flags, so restore() skips the
      //      IndexedDB binding checks; the far-future expiry means getToken()
      //      returns the stub without a refresh
      //   2. /boot answered with the already-deployed machine ("running":
      //      the client skips /boot/ready and polls the real machine itself)
      // Everything downstream — /health, ATC attestation, the release
      // measurement, the TOFU pin, the unlock form — is REAL.
      await page.addInitScript(
        (state) => {
          try {
            localStorage.setItem("betterbase_session_waddle_state", state);
          } catch {}
        },
        JSON.stringify({
          // JWT-shaped so the SDK's claim decode finds a payload (sub/exp).
          accessToken: `smoke.${btoaUrl(JSON.stringify({ sub: "smoke-stub", exp: Math.floor(Date.now() / 1000) + 6 * 3600 }))}.stub`,
          refreshToken: "smoke-stub",
          expiresAt: Date.now() + 6 * 3600_000,
        }),
      );
      await page.route("**/boot", (route) => {
        const cors = {
          "access-control-allow-origin": `http://localhost:${CLIENT_PORT}`,
          "access-control-allow-methods": "POST, OPTIONS",
          "access-control-allow-headers": "authorization, content-type",
        };
        if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
        return route.fulfill({
          status: 200,
          headers: { ...cors, "content-type": "application/json" },
          body: JSON.stringify({ instance, url: machineUrl, status: "running", detail: "smoke discovery stub" }),
        });
      });

      // Prime pass: the first load in a cold dev server can hit vite's
      // "Outdated Optimize Dep" 504s (the dep-optimizer invalidates URLs the
      // page already holds — it breaks the verifier's dynamic sigstore
      // import). Load once, let the churn finish, then measure for real.
      await page.goto(`http://localhost:${CLIENT_PORT}`, { waitUntil: "domcontentloaded" });
      await new Promise((r) => setTimeout(r, 4_000));

      const attested = async (attempt) => {
        await page.goto(`http://localhost:${CLIENT_PORT}`, { waitUntil: "domcontentloaded" });
        // Terminal states: the pin-conflict block, the locked machine's
        // unlock form (#inference-key), or the unlocked machine's Attested
        // screen. Failures always carry the exact "retry" button.
        const blocked = page.getByText("code fingerprint changed");
        const lockedForm = page.locator("#inference-key");
        const attestedScreen = page.getByText("Attested", { exact: true });
        const failed = page.getByRole("button", { name: "retry", exact: true });
        let which = null;
        await Promise.race([
          blocked.waitFor({ timeout: 180_000 }).then(() => (which = "blocked")),
          lockedForm.waitFor({ timeout: 180_000 }).then(() => (which = "locked")),
          attestedScreen.waitFor({ timeout: 180_000 }).then(() => (which = "unlocked")),
          failed.waitFor({ timeout: 180_000 }).then(() => (which = "error")),
        ]).catch(() => {
          which = "timeout";
        });
        if (which === "error") {
          const msg = await page.locator("body").innerText().catch(() => "");
          // Pre-attestation failures are often transient (ATC's intermittent
          // 500s, vite's "Outdated Optimize Dep" 504s on first load) — one
          // reload retry is the documented remedy for both.
          if (attempt === 0) {
            log(`client error screen (${msg.split("\n").find((l) => l.trim()) ?? ""}) — one reload retry`);
            return attested(1);
          }
          for (const e of consoleErrs.slice(-8)) log(`  console: ${e.slice(0, 220)}`);
          await page.screenshot({ path: join(EVIDENCE, "smoke-fail.png"), fullPage: true }).catch(() => {});
          throw new Error(`client error screen: ${msg.slice(0, 300)}`);
        }
        if (which === "timeout") {
          const msg = await page.locator("body").innerText().catch(() => "");
          for (const e of consoleErrs.slice(-8)) log(`  console: ${e.slice(0, 220)}`);
          await page.screenshot({ path: join(EVIDENCE, "smoke-fail.png"), fullPage: true }).catch(() => {});
          throw new Error(`client never reached a terminal screen (last: ${msg.slice(0, 200)})`);
        }
        return which;
      };

      let path = await attested(0);
      let repinned = false;
      if (path === "blocked") {
        // The re-pin: assert the release the enclave presents is exactly the
        // one this ceremony shipped, then pin it.
        const bodyText = await page.locator("body").innerText();
        const release = new RegExp(`release\\s+(v${EXPECT_SERVER})\\b`).exec(bodyText);
        if (!release) throw new Error(`blocked screen shows a release ≠ v${EXPECT_SERVER}:\n${bodyText.slice(0, 400)}`);
        log(`pin conflict shown for ${release[1]} — re-pinning (TOFU)`);
        await page.getByRole("button", { name: "I reviewed it — pin the new fingerprint" }).click();
        repinned = true;
        path = await until(180_000, 1_000, () =>
          Promise.race([
            page.locator("#inference-key").isVisible().then((v) => (v ? "locked" : null)),
            page.getByText("Attested", { exact: true }).isVisible().then((v) => (v ? "unlocked" : null)),
          ]).catch(() => null), "post-repin screen");
      }

      // The stored pin is the assertion that matters: what release and
      // fingerprint this browser now trusts.
      const pin = await page.evaluate(() => {
        try {
          return JSON.parse(localStorage.getItem("waddle.attestation.pin") ?? "null");
        } catch {
          return null;
        }
      });
      if (!pin?.releaseTag || pin.releaseTag !== `v${EXPECT_SERVER}`) {
        throw new Error(`stored pin releaseTag ${pin?.releaseTag} ≠ v${EXPECT_SERVER}`);
      }
      log(`pin: ${pin.releaseTag} fingerprint ${String(pin.codeFingerprint).slice(0, 16)}… (${path === "blocked" ? "re-pinned this run" : "already held"})`);

      if (path === "locked") {
        log(`unlock form reached ✓ (locked machine — the deepest a keyless smoke goes)`);
      } else {
        // An unlocked machine (live session): resume is the CTA.
        await page.getByRole("button", { name: "resume session", exact: true }).click();
        await page.getByText("Delivering your secret…").waitFor({ timeout: 15_000 });
        log(`resume path reached ✓ (machine was unlocked)`);
      }

      const shot = join(EVIDENCE, `smoke-${new Date().toISOString().replace(/[:T]/g, "-").slice(0, 17)}.png`);
      await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
      log(`screenshot: ${shot}`);
      if (consoleErrs.length) log(`(console errors observed: ${consoleErrs.length} — see below)`);
      for (const e of consoleErrs.slice(0, 5)) log(`  pageerror: ${e.slice(0, 160)}`);
      log(`PASS — concierge v${EXPECT_CONCIERGE}, machine v${EXPECT_SERVER} (${instance}), attested + pinned ${pin.releaseTag}, ${repinned ? "re-pinned this run" : "pin already held"}, unlock form reached`);
    } finally {
      await ctx.close().catch(() => {});
    }
  } finally {
    vite.kill("SIGTERM");
    const gone = new Promise((r) => vite.once("exit", r));
    if (!(await Promise.race([gone.then(() => true), new Promise((r) => setTimeout(() => r(false), 4000))]))) vite.kill("SIGKILL");
    if (process.exitCode) log(`vite stderr tail: ${viteErr.join("").slice(-400)}`);
  }
}

main().catch((e) => {
  die(e instanceof Error ? e.message : String(e));
});
