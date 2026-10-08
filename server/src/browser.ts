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
import { mkdirSync, rmSync } from "node:fs";
import WebSocket from "ws";
import { toCdp, type UserInputEvent } from "./input-map.js";

const DATA_DIR = process.env.DATA_DIR ?? "/tmp/waddle-data";
const PROFILE = `${DATA_DIR}/browser`;
// The enclave mounts / read-only (only the DATA_DIR tmpfs is writable).
// Chromium writes TMPDIR/HOME/XDG state and crashpad's database at boot;
// on a read-only root it dies with SIGTRAP before CDP ever answers.

const HOME = `${DATA_DIR}/home`;
const TMP = `${DATA_DIR}/tmp`;
const BROWSER_ENV = {
  ...process.env,
  HOME,
  TMPDIR: TMP,
  XDG_CONFIG_HOME: `${HOME}/.config`,
  XDG_CACHE_HOME: `${HOME}/.cache`,
};
const DEBUG_PORT = 9222;
const CHROMIUM = process.env.WADDLE_CHROMIUM_BIN ?? "chromium";

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

export function userControlActive(): boolean {
  return userControl;
}

export function releaseUserControl(): void {
  if (!userControl) return;
  userControl = false;
  if (controlIdle) clearTimeout(controlIdle);
  controlIdle = null;
  controlNotifier?.(false);
}

function acquireUserControl(): void {
  if (controlIdle) clearTimeout(controlIdle);
  controlIdle = setTimeout(() => releaseUserControl(), USER_CONTROL_IDLE_MS);
  if (userControl) return;
  userControl = true;
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
  const [w, h] = String(r?.result?.value ?? "").split("x").map((n) => parseInt(n, 10));
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
  const live = openDialog
    ? evs
    : evs.filter((ev) => !(ev.t === "key" && ev.k === "Escape"));
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
}

export function browserLive(): boolean {
  return cdp !== null && cdp.readyState === WebSocket.OPEN;
}

/** Boot Chromium + the CDP bridge (idempotent). */
export async function ensureBrowser(): Promise<void> {
  if (browserLive()) return;
  if (booting) return booting;
  booting = (async () => {
    mkdirSync(`${DATA_DIR}/home/.config`, { recursive: true });
    mkdirSync(`${DATA_DIR}/home/.cache`, { recursive: true });
    mkdirSync(`${DATA_DIR}/tmp`, { recursive: true });
    mkdirSync(PROFILE, { recursive: true });
    // Stale singleton locks from a previous container life would kill the
    // browser instantly on a persisted profile — clear them before boot.
    for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
      rmSync(`${PROFILE}/${f}`, { force: true });
    }
    if (!chromium) {
      chromium = spawn(
        CHROMIUM,
        [
          "--headless=new",
          "--no-sandbox",
          "--disable-gpu",
          "--disable-dev-shm-usage",
          "--no-first-run",
          "--no-default-browser-check",
          "--window-size=1280,800",
          "--window-position=0,0",
          `--user-data-dir=${PROFILE}`,
          `--remote-debugging-port=${DEBUG_PORT}`,
          "--remote-allow-origins=*",
          "about:blank",
        ],
        { stdio: "ignore", env: BROWSER_ENV },
      );
      chromium.on("exit", () => {
        chromium = null;
        cdp?.close();
        cdp = null;
      });
    }
    // Poll the debug endpoint until the browser answers.
    const version = await waitForJson<{ webSocketDebuggerUrl?: string }>(`http://127.0.0.1:${DEBUG_PORT}/json/version`, 20_000);
    // Chromium >= 111 exposes the browser-level ws on /json/version; page
    // targets live on /json/list. We drive the first page target.
    await connectPage();
    void version;
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

async function connectPage(): Promise<void> {
  const targets = await waitForJson<Array<{ type: string; webSocketDebuggerUrl: string }>>(`http://127.0.0.1:${DEBUG_PORT}/json/list`, 10_000);
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error("no page target in chromium");
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
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
          resolve();
        } catch (e) {
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
    const frame = params.frame as { url?: string } | undefined;
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
    const res = (await evalInPage(
      `(() => ({ url: location.href, title: document.title }))()`,
    )) as { result?: { value?: { url?: string; title?: string } } };
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
  await waitForLoad(15_000);
  await new Promise((r) => setTimeout(r, 400)); // let first frames render
  await refreshStatus();
  return digest();
}

function waitForLoad(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let finish = (): void => {
      clearTimeout(timer);
      cdp?.off("message", onMsg);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    let done = false;
    function onMsg(raw: unknown) {
      try {
        const msg = JSON.parse(String(raw)) as { method?: string };
        if (msg.method === "Page.loadEventFired") finish();
      } catch {
        /* ignore */
      }
    }
    const inner = finish;
    finish = () => {
      if (done) return;
      done = true;
      inner();
    };
    cdp?.on("message", onMsg);
  });
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
    const kind = e.tagName === 'INPUT' && (e.getAttribute('type') || '').toLowerCase() === 'password' ? 'password field' : '';
    const label = (e.innerText || e.placeholder || e.getAttribute('aria-label') || kind || '').trim().replace(/\\s+/g, ' ').slice(0, 70);
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
  return [
    `title: ${d.title}`,
    `url: ${d.url}`,
    `text:\n${d.text}`,
    `clickable elements (click with browser_click index):\n${d.clickables}`,
  ].join("\n");
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
  await new Promise((r) => setTimeout(r, 700)); // let navigation/render settle
  await refreshStatus();
  const dialog = await settleDialog();
  return dialog ? digest() + "\n[dialog] " + dialog : digest();
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
    el.value = ${JSON.stringify(text)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.tagName.toLowerCase();
  })()`);
  await refreshStatus();
  return "typed";
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
