/**
 * The Eyes: a real Chromium inside the enclave, driven by the agent over
 * CDP, streamed to the user as live frames over the attested ws.
 *
 * Headful under Xvfb (research: CDP screencast from a virtual display is
 * the proven cheap path; OS-level capture → WebRTC is the production
 * upgrade). Frames are ephemeral broadcasts — never sealed into the log.
 * The browser boots lazily on first use and dies with the process.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import WebSocket from "ws";

const DATA_DIR = process.env.DATA_DIR ?? "/tmp/waddle-data";
const PROFILE = `${DATA_DIR}/browser`;
// The enclave mounts / read-only (only the DATA_DIR tmpfs is writable).
// Chromium writes TMPDIR/HOME/XDG state and crashpad's database at boot;
// on a read-only root it dies with SIGTRAP before CDP ever answers.
// X over TCP (no /tmp unix socket — see BROWSER_ENV note).
const X_DISPLAY = "127.0.0.1:99";
const DISPLAY_ARG = ":99";
const HOME = `${DATA_DIR}/home`;
const TMP = `${DATA_DIR}/tmp`;
const BROWSER_ENV = {
  ...process.env,
  DISPLAY: X_DISPLAY,
  HOME,
  TMPDIR: TMP,
  XDG_CONFIG_HOME: `${HOME}/.config`,
  XDG_CACHE_HOME: `${HOME}/.cache`,
};
const DEBUG_PORT = 9222;
const CHROMIUM = process.env.WADDLE_CHROMIUM_BIN ?? "chromium";
const XVFMB_BIN = process.env.WADDLE_XVFB_BIN ?? "Xvfb";

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
let xvfb: ChildProcess | null = null;
let chromium: ChildProcess | null = null;
let cdp: WebSocket | null = null;
let msgId = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let booting: Promise<void> | null = null;
let seq = 0;
let lastSent = 0;
const FRAME_MIN_INTERVAL_MS = 90; // ~11fps wire cap
let currentUrl = "about:blank";
let currentTitle = "";

export function browserLive(): boolean {
  return cdp !== null && cdp.readyState === WebSocket.OPEN;
}

function tmpWritable(): boolean {
  try {
    mkdirSync("/tmp/.X11-unix", { recursive: true });
    return true;
  } catch {
    return false; // read-only /tmp (the enclave) — headless path
  }
}

/** Boot Xvfb + Chromium + the CDP bridge (idempotent). */
export async function ensureBrowser(): Promise<void> {
  if (browserLive()) return;
  if (booting) return booting;
  booting = (async () => {
    mkdirSync(`${DATA_DIR}/home/.config`, { recursive: true });
    mkdirSync(`${DATA_DIR}/home/.cache`, { recursive: true });
    mkdirSync(`${DATA_DIR}/tmp`, { recursive: true });
    mkdirSync(PROFILE, { recursive: true });
    // X needs /tmp writable (lock file, unix socket, xkbcomp keymap — all
    // hardcoded there). The enclave mounts /tmp read-only, so there we run
    // Chromium's new headless instead: same full browser + CDP, no display.
    const headless = !tmpWritable();
    if (!headless && !xvfb) {
      xvfb = spawn(
        XVFMB_BIN,
        [DISPLAY_ARG, "-screen", "0", "1280x800x24", "-nolisten", "unix", "-listen", "tcp", "-ac"],
        { stdio: "ignore", env: BROWSER_ENV },
      );
      await new Promise((r) => setTimeout(r, 400));
    }
    if (!chromium) {
      chromium = spawn(
        CHROMIUM,
        [
          ...(headless ? ["--headless=new"] : [`--display=${X_DISPLAY}`]),
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
  if (msg.method === "Page.loadEventFired") {
    void refreshStatus().catch(() => undefined);
  }
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
  const els = [...document.querySelectorAll(sel)]
    .filter((e) => e.getClientRects().length > 0 && !e.disabled)
    .slice(0, 80);
  els.forEach((e, i) => e.setAttribute('data-waddle-idx', String(i)));
  const clickables = els.map((e, i) => {
    const label = (e.innerText || e.value || e.placeholder || e.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 70);
    return \`[\${i}] <\${e.tagName.toLowerCase()}> \${label}\`;
  });
  return {
    title: document.title,
    url: location.href,
    text: (document.body?.innerText || '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 2200),
    clickables: clickables.join('\\n'),
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
  return digest();
}

/** Type text into the numbered element. */
export async function browserType(index: number, text: string): Promise<string> {
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
