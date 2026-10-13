/**
 * The Eyes: a real Chromium inside the enclave, driven by the agent over
 * CDP, streamed to the user as live frames over the attested ws.
 *
 * Chromium runs --headless=new (the full browser, no display): the enclave
 * mounts /tmp read-only which kills Xvfb (lock file, unix socket, xkbcomp
 * keymap — all hardcoded /tmp), and headless works identically in compose
 * and the enclave — one code path. Frames are ephemeral broadcasts, never
 * sealed into the log; the browser boots lazily and dies with the process.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { chownSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import WebSocket from "ws";
import { toCdp, KEY_NAMES, type UserInputEvent } from "./input-map.js";
import { browserUrlAllowlisted } from "./approvals.js";
import { BROWSER_UID, playpenActive, scrubEnv } from "./guard/policy.js";

const DATA_DIR = process.env.DATA_DIR ?? "/tmp/waddle-data";
const PROFILE = `${DATA_DIR}/browser`;
// The enclave mounts / read-only (only the DATA_DIR tmpfs is writable).
// Chromium writes TMPDIR/HOME/XDG state and crashpad's database at boot;
// on a read-only root it dies with SIGTRAP before CDP ever answers.
// The browser env is scrubbed: the shared secret and the inference key
// are the gateway's, never a child's. A compromised renderer or a
// page-driven chromium crash dump must not be able to printenv them.
const HOME = `${DATA_DIR}/home`;
const TMP = `${DATA_DIR}/tmp`;
const BROWSER_ENV = {
  ...scrubEnv(process.env),
  HOME,
  TMPDIR: TMP,
  XDG_CONFIG_HOME: `${HOME}/.config`,
  XDG_CACHE_HOME: `${HOME}/.cache`,
};
const DEBUG_PORT = 9222;
const CHROMIUM = process.env.WADDLE_CHROMIUM_BIN ?? "chromium";
// The playpen's browser uid (enforced at boot + after restores by
// guard/playpen.ts): the profile — cookies are bearer tokens — is owned
// 0700 by this uid, so the shell (agent uid) cannot read it. Dev hosts
// (unprivileged) spawn without a uid.
const BROWSER_SPAWN_UID = playpenActive() ? { uid: BROWSER_UID, gid: BROWSER_UID } : {};

/** Wire events out of the runtime (broadcast-only; none are logged). */
export interface BrowserEvents {
  onFrame: (dataUrl: string, seq: number) => void;
  onStatus: (status: { url: string; title: string; live: boolean }) => void;
}
let events: BrowserEvents = { onFrame: () => undefined, onStatus: () => undefined };
export function setBrowserEvents(next: BrowserEvents): void {
  events = next;
}

// ── process + CDP state ────────────────────────────────────────────────
let chromium: ChildProcess | null = null;
let cdp: WebSocket | null = null;
let msgId = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let booting: Promise<void> | null = null;
let seq = 0;
let lastSent = 0;
const FRAME_MIN_INTERVAL_MS = 40; // ~25fps wire cap — the dock's img keeps up
let currentUrl = "about:blank";
let currentTitle = "";
/** The main frame's CDP id — subframe navigations (iframes, ads) must not
 *  read as "the page navigated" in the settle heuristics. */
let mainFrameId = "";

// ── page targets (one attached page, new tabs followed) ────────────────
// The CDP bridge drives ONE page: the newest page we know. A click (or the
// user) opening a new tab gets FOLLOWED — attach switches to it, the
// screencast restarts there — and the switch is noted in the next digest;
// the old page stays open in the browser (browser_open goes back).
interface PageTarget {
  id: string;
  type: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}
let pageTargetId: string | null = null;
/** Every page id ever attached or observed — the baseline so pre-existing
 *  tabs never look "new"; only pages appearing LATER are followed. */
const seenPageIds = new Set<string>();
/** A tab-switch note waiting for the next digest (consumed on read, and
 *  dropped if it went stale — a note landing in an unrelated digest
 *  minutes later confuses more than it informs). */
let tabNote: { text: string; at: number } | null = null;
function setTabNote(text: string): void {
  tabNote = { text, at: Date.now() };
}
/** Single-flight: a switch already in progress owns the attach. */
let followInFlight: Promise<string | null> | null = null;
/** The id of the page we have never seen (the new tab), if any — newest
 *  wins. Pure: the caller owns registering ids in `seen`. */
export function pickNewPage(seen: ReadonlySet<string>, pages: Array<{ id: string }>, currentId: string | null): string | null {
  const fresh = pages.filter((p) => p.id !== currentId && !seen.has(p.id));
  return fresh.length > 0 ? fresh[fresh.length - 1]!.id : null;
}

/** Pages the USER opened while driving — registered, never attached:
 *  their tabs are theirs even as fallbacks. */
const userTabs = new Set<string>();

async function listPages(): Promise<PageTarget[]> {
  try {
    const ts = await waitForJson<PageTarget[]>(`http://127.0.0.1:${DEBUG_PORT}/json/list`, 5_000);
    return ts.filter((t) => t.type === "page");
  } catch {
    return []; // browser down/mid-restart: nothing to follow
  }
}

/** Attach to a new tab when one appeared. Returns the note for the digest
 *  (null = nothing to do). Safe to call from anywhere; single-flight. A
 *  fresh tab whose URL is off the browser allowlist is NEVER followed —
 *  following is the same reading class as opening, and opening asks. */
function followNewTab(): Promise<string | null> {
  if (followInFlight) return followInFlight;
  followInFlight = (async () => {
    if (!browserLive()) return null; // dead bridge: the boot path reattaches
    const pages = await listPages();
    const freshId = pickNewPage(seenPageIds, pages, pageTargetId);
    const currentGone = pageTargetId !== null && !pages.some((p) => p.id === pageTargetId);
    for (const p of pages) seenPageIds.add(p.id);
    // A fresh agent-opened tab (allowlist-gated below), or — when the page
    // we were on closed — the newest surviving tab that is neither the
    // user's nor off-allowlist. Everything else is refused honestly.
    let wanted: string | null = freshId;
    if (!wanted && currentGone && pages.length > 0) {
      const fallback = pages[pages.length - 1]!;
      const fallbackUrl = fallback.url ?? "";
      if (userTabs.has(fallback.id)) {
        return "the page we were on was closed — the remaining tab is one the user opened, so it stays theirs; nothing to attach to (browser_open to continue)";
      }
      // Fail CLOSED: no URL (CDP lag, blank tab) means unverifiable — the
      // allowlist cannot say yes, so neither do we.
      if (!fallbackUrl || !browserUrlAllowlisted(fallbackUrl)) {
        return `the page we were on was closed — the remaining tab (${fallbackUrl || "unknown URL"}) is not verifiably on the browser allowlist, so it was not attached (browser_open to continue)`;
      }
      wanted = fallback.id;
    }
    let target = wanted === null ? undefined : pages.find((p) => p.id === wanted);
    if (!target) return null;
    // A brand-new tab can still sit on about:blank (commit pending) —
    // wait briefly for its real URL before the allowlist decides, or a
    // slow-but-legitimate tab would be refused (and permanently seen).
    if (freshId && (!target.url || target.url === "about:blank")) {
      const settled = await waitUntil(
        async () => {
          const again = await listPages();
          const t = again.find((p) => p.id === freshId);
          if (t?.url && t.url !== "about:blank") {
            target = t;
            return true;
          }
          return false;
        },
        { intervalMs: 200, timeoutMs: 3_000 },
      );
      if (!settled) return "a new tab opened but never settled on a URL — not followed; the current page stays attached";
    }
    if (freshId && userTabs.has(freshId)) {
      return "a new tab appeared but it is one the user opened — it stays theirs; the current page stays attached";
    }
    // Registration is async — a tab the user just opened can still be
    // unregistered for a moment after hand-back. The control shadow is the
    // conservative tie-breaker: a fresh tab within 2 s of the user driving
    // is treated as theirs.
    if (freshId && Date.now() - lastUserControlAt < 2_000) {
      return "a new tab appeared right as the user was driving the browser — not followed (it may be theirs); the current page stays attached";
    }
    if (freshId && target.url && !browserUrlAllowlisted(target.url)) {
      return `a new tab opened to ${target.url} — that domain is not on the browser allowlist, so it was NOT followed; the current page stays attached (ask the user, or suggest adding the domain)`;
    }
    if (!target.webSocketDebuggerUrl) return null;
    const previousUrl = currentUrl;
    // Attach to the replacement FIRST; only a successful swap closes the
    // old socket. A failed attach (the new tab died between list and
    // connect — self-closing popups) restores the live bridge untouched.
    const old = cdp;
    try {
      await connectPage(target);
    } catch (e) {
      if (old && old.readyState === WebSocket.OPEN && cdp !== old) cdp = old;
      throw e;
    }
    if (old !== cdp) old?.close(); // connectPage assigned the new socket — retire the old page's
    await refreshStatus();
    return freshId ? `a new tab opened — now following it; the previous page (${previousUrl}) stays open in the browser` : `the page we were on was closed — attached to ${currentUrl}`;
  })()
    .catch(() => null)
    .finally(() => {
      followInFlight = null;
    });
  return followInFlight;
}

// ── user hands: interactive control over the shared browser ────────────
// The user drives with real CDP input events; while they hold control the
// agent's browser tools stand down (they see an explanatory result). Input
// events are NEVER logged — only control transitions are sealed (the log
// must not become a password recorder).
let userControl = false;
let controlIdle: ReturnType<typeof setTimeout> | null = null;
let controlNotifier: ((held: boolean) => void) | null = null;
let openDialog: { message: string; type: string } | null = null; // waiting on the user (Enter/Esc)
let lastDialog: { message: string; type: string } | null = null; // for tool-result reporting
const USER_CONTROL_IDLE_MS = 30_000;

export function setControlNotifier(fn: (held: boolean) => void): void {
  controlNotifier = fn;
}

export function releaseUserControl(): void {
  if (!userControl) return;
  userControl = false;
  lastUserControlAt = Date.now();
  if (controlIdle) clearTimeout(controlIdle);
  controlIdle = null;
  controlNotifier?.(false);
  // Hand-back is exactly when the agent's tools resume — register any tab
  // the user opened RIGHT NOW, not on the debounced clock, or the agent's
  // next click could mistake it for its own fresh tab.
  registerUserTabsNow();
}

/** Immediate bookkeeping pass (the debounced path is for mid-drive). */
function registerUserTabsNow(): void {
  if (!browserLive()) return;
  void listPages().then((pages) => {
    for (const p of pages) {
      seenPageIds.add(p.id);
      if (p.id !== pageTargetId) userTabs.add(p.id);
    }
  });
}

function acquireUserControl(): void {
  if (controlIdle) clearTimeout(controlIdle);
  controlIdle = setTimeout(() => releaseUserControl(), USER_CONTROL_IDLE_MS);
  if (userControl) return;
  userControl = true;
  lastUserControlAt = Date.now();
  controlNotifier?.(true);
}

/** True (with the reason) when the agent must stand down for the user. */
export function userHasTheWheel(): string | null {
  return userControl ? "the user is driving the browser right now — wait for them to hand back (they see your tool calls live), then retry" : null;
}

/** Viewport truth for input mapping: the page reports its own innerWidth/
 *  innerHeight — the exact basis snapshot @(x,y) coords are computed against
 *  (layout metrics can disagree with the page's view; never guess). Short TTL. */
let viewportCache: { w: number; h: number; at: number } | null = null;
async function viewportCss(): Promise<{ w: number; h: number }> {
  if (viewportCache && Date.now() - viewportCache.at < 1000) return viewportCache;
  // evalInPage (send) already resolves with CDP's result object: one unwrap.
  const r = (await evalInPage("[window.innerWidth, window.innerHeight].join('x')")) as {
    result?: { value?: unknown };
  };
  const [w, h] = String(r?.result?.value ?? "")
    .split("x")
    .map((n) => parseInt(n, 10));
  const out = { w: Math.max(1, w || 1280), h: Math.max(1, h || 720), at: Date.now() };
  viewportCache = out;
  return out;
}

/** Dispatch user input: normalized events → CDP Input domain. Native JS
 *  dialogs intercept keys: Enter accepts, Esc dismisses (the user's
 *  “confirm something” — OAuth gates, unload prompts). */
export async function userInput(evs: UserInputEvent[]): Promise<void> {
  await ensureBrowser();
  // Esc is reserved for hand-back client-side; as a key event it only ever
  // means "dismiss the dialog" — drop it (and don't acquire) when none is
  // open, or it would re-acquire control right after a release.
  const live = openDialog ? evs : evs.filter((ev) => !(ev.t === "key" && ev.k === "Escape"));
  if (live.length === 0) return;
  acquireUserControl();
  // A native dialog swallows input: Enter accepts, Esc dismisses — and the
  // consumed key MUST NOT also dispatch to the page (an Enter re-dispatch
  // re-submits the form and spawns a second dialog nothing answers).
  const rest: UserInputEvent[] = [];
  for (const ev of live) {
    if (openDialog && ev.t === "key" && !ev.up && (ev.k === "Enter" || ev.k === "Escape")) {
      await send("Page.handleJavaScriptDialog", { accept: ev.k === "Enter" }).catch(() => undefined);
      openDialog = null;
      continue;
    }
    rest.push(ev);
  }
  if (rest.length === 0 || !browserLive()) return;
  const vp = await viewportCss();
  for (const msg of toCdp(rest, vp)) {
    await send(msg.method, msg.params).catch(() => undefined);
  }
  // Tabs the USER opens are theirs — never followed, and never candidates:
  // register them as seen so the agent's next click can't mistake one for
  // its own fresh tab (registering is bookkeeping — no attach, no read).
  registerUserTabsSoon();
}

let userTabCheck: ReturnType<typeof setTimeout> | null = null;
/** When the user last held the wheel (or just released it) — a fresh tab
 *  appearing in that shadow is conservatively theirs, not followed. */
let lastUserControlAt = 0;
function registerUserTabsSoon(): void {
  if (userTabCheck) clearTimeout(userTabCheck);
  userTabCheck = setTimeout(() => {
    userTabCheck = null;
    if (!browserLive()) return;
    void listPages().then((pages) => {
      for (const p of pages) {
        seenPageIds.add(p.id);
        if (p.id !== pageTargetId) userTabs.add(p.id); // never the attached one
      }
    });
  }, 800);
}

export function browserLive(): boolean {
  return cdp !== null && cdp.readyState === WebSocket.OPEN;
}

/** Boot Chromium + the CDP bridge (idempotent). */
export async function ensureBrowser(): Promise<void> {
  if (browserLive()) return;
  if (booting) return booting;
  booting = (async () => {
    // The playpen pre-creates these with the right owner (guard/playpen.ts);
    // the lazy path here is the fallback — mkdir under the 077 umask would
    // leave them root-only and hand Chromium (browser uid) unwritable dirs,
    // so hand them over when the playpen is active. Never create or chown
    // through a symlinked playpen entry (a restored `home -> /etc` must
    // not get an /etc/.config) — the playpen refuses and surfaces those.
    const isLink = (p: string) => {
      try {
        return lstatSync(p).isSymbolicLink();
      } catch {
        return false;
      }
    };
    // Guard the ANCESTORS, not just the leaves: lstat("…/home/.config")
    // follows a symlinked `home`, so the leaf check alone would hand
    // uid 1101 an outside directory (review-caught). A symlinked playpen
    // entry is the playpen's to refuse and surface; here we just refuse
    // to create or re-own anything through it.
    const homeLink = isLink(`${DATA_DIR}/home`);
    const profileLink = isLink(PROFILE);
    if (!homeLink) {
      mkdirSync(`${DATA_DIR}/home/.config`, { recursive: true });
      mkdirSync(`${DATA_DIR}/home/.cache`, { recursive: true });
    }
    if (!isLink(`${DATA_DIR}/tmp`)) mkdirSync(`${DATA_DIR}/tmp`, { recursive: true });
    if (!profileLink) mkdirSync(PROFILE, { recursive: true });
    if (playpenActive()) {
      for (const d of [`${DATA_DIR}/home/.config`, `${DATA_DIR}/home/.cache`, PROFILE]) {
        if ((d === PROFILE ? profileLink : homeLink) || isLink(d)) continue;
        try {
          chownSync(d, BROWSER_UID, BROWSER_UID);
        } catch {
          /* missing or not ours to give: the playpen owns the discipline,
       and a single un-chownable entry must not reject the boot */
        }
      }
    }
    // Stale singleton locks from a previous container life would kill the
    // browser instantly on a persisted profile — clear them before boot.
    for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
      rmSync(`${PROFILE}/${f}`, { force: true });
    }
    if (!chromium) {
      chromium = spawn(
        CHROMIUM,
        ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check", "--window-size=1280,800", "--window-position=0,0", `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${DEBUG_PORT}`, "--remote-allow-origins=*", "about:blank"],
        { stdio: "ignore", env: BROWSER_ENV, ...BROWSER_SPAWN_UID },
      );
      const child = chromium;
      const failure = { error: null as Error | null };
      // uid/gid 1101 spawn failures (missing uid on a foreign host, binary
      // gone) arrive as an async 'error' event — unhandled it crashes the
      // gateway, and a bound-but-dead handle wedges every later boot
      // (review-caught). Clear the handle so the next ensureBrowser retries,
      // and remember why for the failure message.
      child.once("error", (err: Error) => {
        failure.error = err;
        if (chromium === child) chromium = null;
        cdp?.close();
        cdp = null;
      });
      child.once("exit", () => {
        if (chromium === child) chromium = null;
        cdp?.close();
        cdp = null;
      });
      // Poll the debug endpoint until the browser answers (body unused —
      // /json/list is where the page targets live; we drive the first).
      try {
        await waitForJson(`http://127.0.0.1:${DEBUG_PORT}/json/version`, 20_000);
      } catch (err) {
        if (failure.error) throw new Error(`browser failed to start: ${failure.error.message}`);
        throw err;
      }
    } else {
      await waitForJson(`http://127.0.0.1:${DEBUG_PORT}/json/version`, 20_000);
    }
    await connectPage();
  })().finally(() => {
    booting = null;
  });
  return booting;
}

async function waitForJson<T>(url: string, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return (await res.json()) as T;
      lastErr = `HTTP ${res.status}`;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`chromium debug endpoint never answered (${lastErr})`);
}

async function connectPage(preferred?: PageTarget): Promise<void> {
  // Register every current page so pre-existing tabs never look "new" —
  // only pages appearing AFTER an attach are follow candidates.
  const pages = await listPages();
  for (const p of pages) seenPageIds.add(p.id);
  const page = preferred ?? pages[0];
  const wsUrl = page?.webSocketDebuggerUrl;
  if (!wsUrl) throw new Error("no page target in chromium");
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
    ws.on("message", (raw) => handleCdp(String(raw)));
    ws.on("open", () => {
      cdp = ws;
      void (async () => {
        try {
          await send("Page.enable");
          await send("Runtime.enable");
          await send("Page.startScreencast", {
            format: "jpeg",
            quality: 55,
            maxWidth: 1024,
            maxHeight: 640,
            everyNthFrame: 1,
          });
          await refreshStatus();
          // Attached for real only now — a failed init must leave the old
          // pageTargetId (and the follower's bookkeeping) untouched.
          pageTargetId = page.id;
          resolve();
        } catch (e) {
          // Open but half-initialized (an enable failed): close the socket
          // rather than leaving a live-looking dead bridge — its close
          // handler nulls cdp and the next ensureBrowser() reattaches.
          ws.close();
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      })();
    });
    ws.on("error", (e) => {
      if (cdp === ws) cdp = null;
      reject(e instanceof Error ? e : new Error(String(e)));
    });
    ws.on("close", () => {
      if (cdp === ws) cdp = null;
    });
  });
}

function handleCdp(raw: string): void {
  const msg = JSON.parse(raw) as {
    id?: number;
    result?: unknown;
    error?: { message: string };
    method?: string;
    params?: Record<string, unknown>;
  };
  if (typeof msg.id === "number") {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    }
    return;
  }
  const params = msg.params ?? {};
  if (msg.method === "Page.screencastFrame") {
    const data = String(params.data ?? "");
    const sid = Number(params.sessionId ?? 0);
    // Always ack (keeps frames flowing), but throttle what leaves the VM.
    void send("Page.screencastFrameAck", { sessionId: sid }).catch(() => undefined);
    const now = Date.now();
    if (now - lastSent >= FRAME_MIN_INTERVAL_MS && data) {
      lastSent = now;
      events.onFrame(`data:image/jpeg;base64,${data}`, seq++);
    }
    return;
  }
  if (msg.method === "Page.frameNavigated") {
    const frame = params.frame as { url?: string; parentId?: string; id?: string } | undefined;
    // The main frame carries no parentId; its id (NOT params.frameId —
    // frameNavigated has no such field) anchors same-document nav checks.
    if (frame && frame.parentId === undefined) mainFrameId = String(frame.id ?? "");
    if (frame?.url && frame.url !== "about:blank") currentUrl = frame.url;
  }
  if (msg.method === "Page.javascriptDialogOpening") {
    // Dialog watchdog: a native dialog blocks the page until handled — and
    // the evaluate that spawned it (agent clicks) hangs inside the dialog.
    // While the user holds the wheel, THEY answer (Enter/Esc via userInput).
    // An agent-spawned one is declined on the spot; settleDialog reports it.
    lastDialog = { message: String(params.message ?? ""), type: String(params.type ?? "alert") };
    openDialog = userControl ? lastDialog : null;
    if (!userControl) {
      void send("Page.handleJavaScriptDialog", { accept: false }).catch(() => undefined);
    }
  }
  if (msg.method === "Page.loadEventFired") {
    void refreshStatus().catch(() => undefined);
  }
}

/** Report (and clear) the dialog the agent's last action spawned — already
 *  declined by the watchdog the moment it opened; this just tells the model. */
async function settleDialog(): Promise<string | null> {
  if (!lastDialog) return null;
  const d = lastDialog;
  lastDialog = null;
  return `a ${d.type} dialog appeared: "${d.message.slice(0, 120)}" — auto-declined; if the task needs it accepted, ask the user to confirm it themselves`;
}

/** Gracefully stop Chromium so it flushes cookies/localStorage to disk —
 *  call before checkpointing the profile. */
export async function stopBrowser(): Promise<void> {
  const proc = chromium;
  if (!proc) return;
  try {
    await send("Browser.close");
  } catch {
    proc.kill("SIGTERM");
  }
  await new Promise<void>((resolve) => {
    const kill = setTimeout(() => proc.kill("SIGKILL"), 5_000);
    proc.once("exit", () => {
      clearTimeout(kill);
      resolve();
    });
  });
}

function send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const ws = cdp;
  if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("browser not connected"));
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    ws.send(JSON.stringify({ id, method, params: params ?? {} }));
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`CDP ${method} timed out`));
    }, 20_000);
  }) as Promise<Record<string, unknown>>;
}

async function refreshStatus(): Promise<void> {
  try {
    const res = (await evalInPage(`(() => ({ url: location.href, title: document.title }))()`)) as { result?: { value?: { url?: string; title?: string } } };
    const v = res?.result?.value ?? {};
    if (v.url) currentUrl = v.url;
    if (typeof v.title === "string") currentTitle = v.title;
  } catch {
    /* pre-load page: keep last known */
  }
  events.onStatus({ url: currentUrl, title: currentTitle, live: browserLive() });
}

async function evalInPage(expression: string): Promise<unknown> {
  return send("Runtime.evaluate", { expression, returnByValue: true });
}

// ── agent actions (tool backends) ──────────────────────────────────────

/** Navigate and settle. Returns a digest for the model. */
export async function browserNavigate(url: string): Promise<string> {
  const wheel = userHasTheWheel();
  if (wheel) return wheel;
  await ensureBrowser();
  const target = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  const nav = (await send("Page.navigate", { url: target })) as { errorText?: string };
  if (nav?.errorText) throw new Error(`navigation failed: ${nav.errorText}`);
  await waitForReady(15_000);
  await new Promise((r) => setTimeout(r, 400)); // let first frames render
  await refreshStatus();
  return digest();
}

/** Poll `check` until true or the deadline. A throwing check reads as
 *  not-yet (the mid-navigation shape: the old context is gone) — the
 *  deadline, not an exception, decides when waiting is over. Pure timing
 *  helper. */
export async function waitUntil(check: () => Promise<boolean> | boolean, opts: { intervalMs: number; timeoutMs: number }): Promise<boolean> {
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    try {
      if (await check()) return true;
    } catch {
      /* not-yet */
    }
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, opts.intervalMs));
  }
}

/** Wait for document.readyState === "complete" by polling — immune to the
 *  subscribe-after-load race (a loadEventFired listener attached after a
 *  fast page finished would stall to its full timeout). Mid-navigation
 *  evaluates throw (old context gone): that's just "not ready". */
async function waitForReady(timeoutMs: number): Promise<boolean> {
  return waitUntil(
    async () => {
      if (!browserLive()) return false;
      try {
        const r = (await evalInPage("document.readyState")) as { result?: { value?: string } };
        return r?.result?.value === "complete";
      } catch {
        return false;
      }
    },
    { intervalMs: 200, timeoutMs },
  );
}

/** True within `windowMs` if the MAIN frame starts navigating (a real nav:
 *  frameNavigated on the main frame, or a same-document URL change). SPA
 *  clicks never navigate — the window just lapses and the caller settles
 *  briefly instead. Subframe navigations (iframes, ads) don't count. */
function waitForNavigationStart(windowMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cdp?.off("message", onMsg);
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), windowMs);
    function onMsg(raw: unknown) {
      try {
        const msg = JSON.parse(String(raw)) as {
          method?: string;
          params?: { frame?: { url?: string; parentId?: string }; frameId?: string };
        };
        if (msg.method === "Page.frameNavigated") {
          const f = msg.params?.frame;
          if (f?.parentId === undefined && f?.url && f.url !== "about:blank") finish(true);
        } else if (msg.method === "Page.navigatedWithinDocument") {
          if (msg.params?.frameId === mainFrameId) finish(true);
        }
      } catch {
        /* ignore */
      }
    }
    cdp?.on("message", onMsg);
  });
}

/** Post-action settle: wait briefly for a navigation to start; if it does,
 *  ride it to completion (readyState) plus a paint breath. If not (SPA
 *  mutation), just let the paint settle — no blind full-timeout stalls. */
async function settleAfterAction(): Promise<void> {
  const started = Date.now();
  if (await waitForNavigationStart(700)) {
    await waitForReady(15_000);
    await new Promise((r) => setTimeout(r, 350));
    return;
  }
  const rest = Math.max(0, 700 - (Date.now() - started));
  await new Promise((r) => setTimeout(r, rest));
}

const SNAPSHOT_JS = `(() => {
const sel = 'a,button,input,textarea,select,[role="button"]';
// Tightest container wins: MediaWiki's #mw-content-text and semantic
// <article>/<main> beat generic wrappers like Vector's #content, which
// contains the page tabs (Article/Talk) — chrome, not content.
let main = null;
for (const s of ['#mw-content-text', 'article', 'main', '[role="main"]', '#content']) {
main = document.querySelector(s);
if (main) break;
}
const ranked = [...document.querySelectorAll(sel)]
.filter((e) => e.getClientRects().length > 0 && !e.disabled)
.map((e) => ({ e, inMain: main ? main.contains(e) : false }))
.sort((a, b) => Number(b.inMain) - Number(a.inMain));
const els = ranked.slice(0, 120).map((r) => r.e);
els.forEach((e, i) => e.setAttribute('data-waddle-idx', String(i)));
const vw = Math.max(1, window.innerWidth), vh = Math.max(1, window.innerHeight);
const clickables = els.map((e, i) => {
const kind = e.tagName === 'INPUT' && (e.getAttribute('type') || '').toLowerCase() === 'password' ? 'password field' : e.tagName === 'SELECT' ? 'select, ' + e.options.length + ' options (browser_select)' : '';
const label = (kind || e.innerText || e.placeholder || e.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 70);
const r = e.getBoundingClientRect();
const cx = ((r.left + r.width / 2) / vw).toFixed(2), cy = ((r.top + Math.min(r.height, 60) / 2) / vh).toFixed(2);
return \`[\${i}] <\${e.tagName.toLowerCase()}> \${label} @(\${cx},\${cy})\`;
});
return {
title: document.title,
url: location.href,
// Text follows the viewport: the excerpt window slides with scrollY so
// browser_scroll reveals content below the initial fold.
text: (() => {
const full = (document.body?.innerText || '').replace(/\\n{3,}/g, '\\n\\n');
const scrollable = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
const ratio = Math.min(1, Math.max(0, window.scrollY / scrollable));
const win = 2200;
const start = Math.floor(ratio * Math.max(0, full.length - win));
return full.slice(start, start + win) + (start > 0 ? '\\n[excerpt at scroll position — browser_scroll to read more]' : '');
})(),
clickables:
'Clickable elements cover the whole page (not just the viewport);\\n' +
'lowest indexes are main content. Page TEXT follows the current\\n' +
'scroll position.\\n' +
clickables.join('\\n'),
};
})()`;

interface PageDigest {
  title: string;
  url: string;
  text: string;
  clickables: string;
}

async function digest(): Promise<string> {
  const res = (await evalInPage(SNAPSHOT_JS)) as { result?: { value?: PageDigest } };
  const d = res?.result?.value;
  if (!d) throw new Error("snapshot failed — page not ready");
  const note = tabNote && Date.now() - tabNote.at < 5_000 ? tabNote.text : null;
  tabNote = null;
  return [`title: ${d.title}`, `url: ${d.url}`, `text:\n${d.text}`, `clickable elements (click with browser_click index):\n${d.clickables}`, ...(note ? [`[tab] ${note}`] : [])].join("\n");
}

/** Fresh DOM digest for the model. */
export async function browserSnapshot(): Promise<string> {
  await ensureBrowser();
  await refreshStatus();
  return digest();
}

/** Click the numbered element (indexes come from the snapshot). */
export async function browserClick(index: number): Promise<string> {
  const wheel = userHasTheWheel();
  if (wheel) return wheel;
  await ensureBrowser();
  await evalInPage(`(() => {
const el = document.querySelector('[data-waddle-idx="${index}"]');
if (!el) return 'no such element — take a fresh browser_snapshot';
el.style.outline = '3px solid #6366f1';
el.style.outlineOffset = '2px';
setTimeout(() => { el.style.outline = ''; }, 900);
el.scrollIntoView({ block: 'center' });
el.click();
return el.tagName.toLowerCase();
})()`);
  await settleAfterAction();
  const note = await followNewTab(); // target=_blank clicks open tabs
  if (note) setTabNote(note);
  await refreshStatus();
  const dialog = await settleDialog();
  const page = await digest();
  return dialog ? page + "\n[dialog] " + dialog : page;
}

/** Scroll the page (long pages are unreadable from the top alone). */
export async function browserScroll(direction: "up" | "down", amount: number): Promise<string> {
  const wheel = userHasTheWheel();
  if (wheel) return wheel;
  await ensureBrowser();
  const px = Math.max(50, Math.min(3000, Math.round(amount)));
  const delta = direction === "down" ? px : -px;
  await evalInPage(`(() => {
  window.scrollBy({ top: ${delta}, behavior: "instant" });
  return location.href + " @" + Math.round(window.scrollY);
})()`);
  await new Promise((r) => setTimeout(r, 350)); // let new content paint/settle
  return digest();
}

/** Type text into the numbered element. */
export async function browserType(index: number, text: string): Promise<string> {
  const wheel = userHasTheWheel();
  if (wheel) return wheel;
  await ensureBrowser();
  await evalInPage(`(() => {
    const el = document.querySelector('[data-waddle-idx="${index}"]');
    if (!el) return 'no such element — take a fresh browser_snapshot';
    el.focus();
    // React & friends override the value property with a tracker — a
    // direct el.value write is INVISIBLE to them (the classic silent
    // no-op on controlled inputs). Write through the prototype's native
    // setter so the framework's own listener sees a real value change.
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value');
    if (setter && setter.set) setter.set.call(el, ${JSON.stringify(text)});
    else el.value = ${JSON.stringify(text)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.tagName.toLowerCase();
  })()`);
  await new Promise((r) => setTimeout(r, 300));
  await refreshStatus();
  return digest();
}

/** Wait until `text` appears on the page or `gone` leaves it — the
 *  deterministic replacement for snapshot-after-blind-sleep. Timeout
 *  returns the current page with an honest note (never a hang). */
export function buildWaitProbe(waitFor: string, gone: string): string {
  const need = waitFor ? `t.includes(${JSON.stringify(waitFor)})` : "true";
  const absent = gone ? `!t.includes(${JSON.stringify(gone)})` : "true";
  return `(() => { const t = document.body?.innerText ?? ''; return ${need} && ${absent}; })()`;
}

export async function browserWaitFor(opts: { text?: string; gone?: string; timeoutMs?: number }): Promise<string> {
  const wheel = userHasTheWheel();
  if (wheel) return wheel;
  if (!opts.text && !opts.gone) {
    return "wait failed: pass text (wait until it appears) or gone (wait until it disappears)";
  }
  await ensureBrowser(); // args validated first — a malformed call never boots Chromium
  const timeout = Math.min(30_000, Math.max(250, opts.timeoutMs ?? 10_000));
  const started = Date.now();
  const probe = buildWaitProbe(opts.text ?? "", opts.gone ?? "");
  const found = await waitUntil(
    async () => {
      if (!browserLive()) return false;
      const r = (await evalInPage(probe)) as { result?: { value?: boolean } };
      return r?.result?.value === true;
    },
    { intervalMs: 300, timeoutMs: timeout },
  );
  const waited = Date.now() - started;
  const page = await digest();
  if (!found) {
    const what = opts.text ? `"${opts.text}" never appeared` : `"${opts.gone}" is still on the page`;
    return `timed out after ${waited}ms — ${what}. Current page:\n${page}`;
  }
  const on = opts.text ? `"${opts.text}"` : `"${opts.gone}" to leave`;
  return `waited ${waited}ms for ${on}\n${page}`;
}

/** Send a real key event to the page (Enter submits forms, arrows move —
 *  the same pipeline the user's keyboard rides). */
export async function browserPressKey(key: string): Promise<string> {
  const wheel = userHasTheWheel();
  if (wheel) return wheel;
  const msgs = toCdp(
    [
      { t: "key", k: key },
      { t: "key", k: key, up: true },
    ],
    { w: 1, h: 1 },
  );
  if (msgs.length === 0) {
    return `unknown key "${key}" — supported: ${KEY_NAMES.join(", ")}`;
  }
  await ensureBrowser(); // unknown keys answered before any Chromium work
  for (const m of msgs) await send(m.method, m.params).catch(() => undefined);
  await settleAfterAction(); // Enter often submits → navigation
  const note = await followNewTab(); // …or opens a new tab
  if (note) setTabNote(note);
  await refreshStatus();
  const dialog = await settleDialog();
  const page = await digest();
  return dialog ? page + "\n[dialog] " + dialog : page;
}

/** Choose an option in a <select> (dropdown) element by snapshot index.
 *  Value matches the option's value, its visible text, or a case-insensitive
 *  substring of the text; a miss lists what the dropdown offers. */
export async function browserSelect(index: number, value: string): Promise<string> {
  const wheel = userHasTheWheel();
  if (wheel) return wheel;
  await ensureBrowser();
  const r = (await evalInPage(`(() => {
    const el = document.querySelector('[data-waddle-idx="${index}"]');
    if (!el) return 'no such element — take a fresh browser_snapshot';
    if (el.tagName !== 'SELECT') return 'no dropdown at element ${index} — it is a ' + el.tagName.toLowerCase() + ' (browser_select needs a <select> from the snapshot)';
    const want = ${JSON.stringify(value)};
    const opts = [...el.options];
    const hit = opts.find((o) => o.value === want)
      || opts.find((o) => (o.textContent || '').trim() === want)
      || opts.find((o) => (o.textContent || '').trim().toLowerCase().includes(want.toLowerCase()));
    if (!hit) {
      const menu = opts.map((o) => (o.textContent || o.value).trim()).join(' | ').slice(0, 400);
      return 'no option matching "' + want + '" — options: ' + menu;
    }
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
    if (setter && setter.set) setter.set.call(el, hit.value);
    else el.value = hit.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return 'selected ' + (hit.textContent || hit.value).trim();
  })()`)) as { result?: { value?: string } };
  const v = r?.result?.value ?? "select failed — page not ready";
  if (v.startsWith("no ")) return v; // honest miss: the model sees why
  await new Promise((res) => setTimeout(res, 300));
  await refreshStatus();
  return v + "\n" + (await digest());
}

/** Force a frame now (new client attach / preview refresh). */
export async function captureNow(): Promise<void> {
  if (!browserLive()) return;
  try {
    const shot = (await send("Page.captureScreenshot", { format: "jpeg", quality: 55 })) as { data?: string };
    if (shot?.data) events.onFrame(`data:image/jpeg;base64,${shot.data}`, seq++);
  } catch {
    /* browser mid-navigation: frames will flow */
  }
}
