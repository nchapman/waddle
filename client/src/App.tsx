import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { verifyEnclave, repin, type AttestationResult } from "./lib/attestation";
import { unlock, getState, forgetSecret, getToken, getInferenceKey, setInferenceKey } from "./lib/session";
import { connectChat, type ServerEvent, type ChatConnection } from "./lib/ws";
import {
  openAccountStore,
  ensureMachineAnchor,
  type AccountStore,
} from "./lib/betterbase-store";
import { getSecret } from "./lib/session";
import type { StateResponse } from "@waddle/sdk";
import type { UIMessage } from "@ai-sdk/react";
import { ChatSurface } from "./ChatSurface";
import { BrowserDock, BrowserOverlay } from "./components/BrowserDock";
import type { InputEvent } from "./components/InteractFrame";
import { Shell, StoreFooter } from "./components/Shell";
import { Chip } from "./components/DuckMark";
import { ApprovalCard } from "./components/ApprovalCard";
import {
  VerifyingScreen,
  AttestedScreen,
  BlockedScreen,
  UnlockingScreen,
  LockedForm,
  AsleepScreen,
  ErrorScreen,
} from "./components/Ceremony";
import { useAuth } from "betterbase/auth/react";
import { BetterbaseProvider } from "betterbase/sync/react";
import { COLLECTIONS } from "./lib/bb-collections";
import { buildBbGrant, resolveSyncEndpoint } from "./lib/bb-grant";
import { frameBus } from "./lib/frame-bus";
import { WaddleChatTransport } from "./lib/waddle-transport";

const DEV = import.meta.env.VITE_DEV === "1";
const ENCLAVE_URL =
  import.meta.env.VITE_ENCLAVE_URL ?? "https://waddle.ddg-waddle.containers.tinfoil.dev";
const CONFIG_REPO = import.meta.env.VITE_CONFIG_REPO ?? "nchapman/waddle-config";
const CONCIERGE_URL = import.meta.env.VITE_CONCIERGE_URL ?? "http://localhost:5390";
const CONCIERGE_TOKEN = import.meta.env.VITE_CONCIERGE_TOKEN ?? "waddle-dev";
/** The machine this session talks to: the primary, or a warm standby
 *  handed out by the concierge's pool (same config repo → same
 *  measurement → the TOFU pin travels with it). */
let activeEnclave = ENCLAVE_URL;

interface ChatMessage {
  role: "user" | "assistant" | "tool";
  text: string;
  error?: boolean;
  /** Structured tool call (live + replay) — the seed renders real chips. */
  tool?: { name: string; args?: unknown; result?: unknown; isError?: boolean };
}
export type { ChatMessage };

type State =
  | { phase: "verifying" }
  | { phase: "asleep"; waking: boolean; note?: string }
  | { phase: "error"; message: string }
  | { phase: "blocked"; result: AttestationResult }
  | { phase: "attested"; result: AttestationResult; locked: boolean }
  | { phase: "unlocking" }
  | {
      phase: "chat";
      result: AttestationResult;
      messages: ChatMessage[];
      streaming: string;
      connected: boolean;
      replayed: boolean;
      error?: string;
      pendingApproval?: { callId: string; tool: string; input: unknown };
      frameLive?: boolean;
      browserUrl?: string;
      browserTitle?: string;
      browserHeld?: boolean;
    };

const box = (bg: string): React.CSSProperties => ({
  background: bg,
  borderRadius: 8,
  padding: "0.35rem 0.7rem",
  fontFamily: "ui-monospace, monospace",
  fontSize: 13,
  wordBreak: "break-all",
});
const fp = (s: string) => `${s.slice(0, 16)}…${s.slice(-8)}`;

/** Dev parity: a structural stand-in so session/unlock code paths run unchanged. */
const DEV_RESULT = {
  ok: true,
  client: { fetch: (...a: Parameters<typeof fetch>) => fetch(...a) },
  configRepo: "dev",
  enclaveHost: "localhost",
  releaseTag: "dev",
  releaseDigest: "",
  codeFingerprint: "",
  steps: {},
  firstPin: false,
} as unknown as import("./lib/attestation").AttestationResult;




/** Parse the legacy emoji mono format back into structured tool rows. */
function parseToolText(text: string): ChatMessage["tool"] | undefined {
  const start = /^⚙️ (\S+) (\{.*\})$/s.exec(text);
  if (start) {
    try {
      return { name: start[1]!, args: JSON.parse(start[2]!) as unknown };
    } catch {
      return { name: start[1]!, args: start[2] };
    }
  }
  const end = /^([⛔✔]) (\S+) → (.*)$/s.exec(text);
  if (end) {
    let result: unknown = end[3];
    try {
      result = JSON.parse(end[3]!) as unknown;
    } catch {
      /* result excerpt was truncated — keep the text */
    }
    return { name: end[2]!, result, isError: end[1] === "⛔" };
  }
  return undefined;
}

/** Deterministic history seed: map sealed log events to surface rows. */
function eventsToRows(events: Array<Record<string, unknown>>): ChatMessage[] {
  const rows: ChatMessage[] = [];
  for (const e of events) {
    const t = e.type as string | undefined;
    if (t === "message" && (e.role === "user" || e.role === "assistant")) {
      rows.push({ role: e.role as "user" | "assistant", text: String(e.text ?? "") });
    } else if (t === "history_row" && typeof e.text === "string") {
      const role = e.role as ChatMessage["role"];
      rows.push({ role, text: e.text, ...(role === "tool" ? { tool: parseToolText(e.text) } : {}) });
    } else if (t === "tool_start") {
      rows.push({
        role: "tool",
        text: `⚙️ ${e.tool} ${JSON.stringify(e.args ?? {}).slice(0, 140)}`,
        tool: { name: String(e.tool ?? ""), args: e.args ?? {} },
      } as ChatMessage);
    } else if (t === "tool_end") {
      const result = JSON.stringify(e.result ?? "").slice(0, 100);
      rows.push({
        role: "tool",
        text: `${e.isError ? "⛔" : "✔"} ${e.tool} → ${result}`,
        tool: { name: String(e.tool ?? ""), result: e.result ?? "", isError: !!e.isError },
      } as ChatMessage);
    }
  }
  return rows;
}


export function App() {
  const [state, setState] = useState<State>({ phase: "verifying" });
  const [browserExpanded, setBrowserExpanded] = useState(false);
  const [keyInput, setKeyInput] = useState(getInferenceKey());
  const connRef = useRef<ChatConnection | null>(null);
  const transportRef = useRef<WaddleChatTransport | null>(null);
  const bb = useAuth();
  // Live view of the auth hydration flag for async flows (closures capture
  // a stale boolean; this ref tracks it across renders).
  const bbLoadingRef = useRef(bb.isLoading);
  bbLoadingRef.current = bb.isLoading;
  const [bbStore, setBbStore] = useState<AccountStore | null>(null);
  const bbStoreReadyRef = useRef<Promise<AccountStore | null> | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  const attestedClientRef = useRef<AttestationResult["client"] | null>(null);
  // True while the ws backlog for an already-seeded log streams in — its
  // rows are in the seed, so ingesting them again would duplicate history.
  const suppressReplayRef = useRef(false);
  const frameLiveRef = useRef(false);
  // The pi transcript (jsonl) only grows when a turn is sealed — refetching
  // it (and re-encrypting MBs) on every debounced push was the idle-CPU
  // storm's fuel. Cache it, refetch only when the row count moved.
  const jsonlCacheRef = useRef<{ len: number; jsonl: string | null }>({ len: -1, jsonl: null });
  const pushBlockedUntilRef = useRef(0);
  const autoWokeRef = useRef(false);
  if (!transportRef.current) transportRef.current = new WaddleChatTransport();

  /** Wake through the concierge: POST the verb, poll the enclave, re-run
   *  the unlock flow when it answers. Shared by the manual button and the
   *  load-time auto-wake (once per page load). Auth prefers the betterbase
   *  session token (the TEE'd concierge verifies it); dev falls back to
   *  the shared-secret env. */
  async function wakeCore(note: string) {
    setState({ phase: "asleep", waking: true, note });
    activeEnclave = ENCLAVE_URL; // the wake path always targets the primary
    const bbToken = await bb.session?.getToken().catch(() => null);
    const auth = bbToken ?? CONCIERGE_TOKEN;
    try {
      const res = await fetch(`${CONCIERGE_URL}/wake`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth}` },
        body: JSON.stringify({ instance: "waddle" }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        setState((st) => (st.phase === "asleep" ? { ...st, waking: false, note: `concierge refused (${res.status}) ${body.slice(0, 120)}` } : st));
        return;
      }
    } catch {
      setState((st) => (st.phase === "asleep" ? { ...st, waking: false, note: "concierge unreachable — is it running?" } : st));
      return;
    }
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const res = await fetch(`${activeEnclave}/health`, { signal: AbortSignal.timeout(4000) });
        if (res.ok) {
          void run();
          return;
        }
      } catch {
        /* still booting */
      }
      setState((st) => (st.phase === "asleep" ? { ...st, note: `waiting for the enclave… (${i + 1})` } : st));
    }
    setState((st) => (st.phase === "asleep" ? { ...st, waking: false, note: "gave up waiting — try again" } : st));
  }

  const run = useCallback(async () => {
    setState({ phase: "verifying" });
    try {
      if (DEV) {
        const res = await fetch(`${activeEnclave}/health`);
        const health = (await res.json()) as { locked: boolean };
        setState({ phase: "attested", result: DEV_RESULT, locked: health.locked });
        return;
      }
      const result = await verifyEnclave(activeEnclave, CONFIG_REPO);
      if (result.pinConflict) {
        setState({ phase: "blocked", result });
        return;
      }
      const res = await result.client.fetch(`${activeEnclave}/health`);
      const health = (await res.json()) as { locked: boolean };
      setState({ phase: "attested", result, locked: health.locked });
    } catch (e) {
      // Auto-wake only on genuine unreachability: a network-level probe of
      // /health. Attestation/config failures with a live enclave go to the
      // error screen — waking can't help those (and a spurious /wake would
      // stop-and-redeploy a healthy machine via zombie recovery).
      if (!DEV) {
        // A standby that fails verification must not strand the session:
        // fall back to the primary wake path (which resets activeEnclave).
        // Checked BEFORE the autoWokeRef gate — the assign path already
        // consumed it, but a bad standby still deserves the fallback.
        if (activeEnclave !== ENCLAVE_URL) {
          autoWokeRef.current = true;
          void wakeCore("standby failed verification — waking the primary");
          return;
        }
      }
      if (!DEV && !autoWokeRef.current) {
        let unreachable = false;
        try {
          await fetch(`${ENCLAVE_URL}/health`, { signal: AbortSignal.timeout(2500) });
        } catch {
          unreachable = true;
        }
        if (unreachable) {
          autoWokeRef.current = true;
          // Pool first: a warm standby means ~7s to live (attest + unlock)
          // instead of a ~75s deploy. Same measured config → the pin holds.
          const bbToken = await bb.session?.getToken().catch(() => null);
          try {
            const res = await fetch(`${CONCIERGE_URL}/assign`, {
              headers: { Authorization: `Bearer ${bbToken ?? CONCIERGE_TOKEN}` },
              signal: AbortSignal.timeout(5000),
            });
            if (res.ok) {
              const m = (await res.json().catch(() => null)) as { name?: string; url?: string } | null;
              // Zone-bind the handed-out URL: the standby must live in the
              // same operator domain as the primary — the TOFU pin travels
              // by measurement, so it cannot catch a host switch.
              const zone = `.${new URL(ENCLAVE_URL).hostname.split(".").slice(1).join(".")}`;
              const host = m && typeof m.url === "string" ? new URL(m.url).hostname : "";
              if (host.endsWith(zone)) {
                activeEnclave = m!.url!;
                void run(); // verify the standby; its unlock flow continues there
                return;
              }
            }
          } catch {
            /* concierge unreachable — fall through to the wake path */
          }
          void wakeCore("auto-wake: enclave unreachable on load");
          return;
        }
      }
      setState({ phase: "error", message: e instanceof Error ? e.message : String(e) });
    }
    // eslint-disable-next-line -- wakeCore is a hoisted function declaration
  }, []);

  useEffect(() => {
    void run();
    return () => connRef.current?.close();
  }, [run]);


  const onServerEvent = useCallback((event: ServerEvent) => {
    // Frame events never touch React state: they publish to the bus (the
    // dock/overlay <img> subscribe alone). Publish HERE, outside the state
    // updater — publishing inside it fired subscriber setStates during
    // React's render pass ("update while rendering" warnings). The liveness
    // flag flips once on first frame, never per frame.
    if (event.type === "frame") {
      frameBus.publish({ data: event.data, seq: event.seq });
      if (!frameLiveRef.current) {
        frameLiveRef.current = true;
        setState((s) => (s.phase === "chat" ? { ...s, frameLive: true } : s));
      }
      return;
    }
    setState((s) => {
      // replay_done must land even while the unlock transition is finishing,
      // or the chat waits forever on "replaying history…". It also disarms
      // backlog suppression (the backlog is fully streamed by then).
      if (event.type === "replay_done") {
        suppressReplayRef.current = false;
        return s.phase === "chat" ? { ...s, replayed: true } : s;
      }
      if (suppressReplayRef.current && s.phase === "chat") {
        // Backlog duplicate of the seeded history — drop.
        if (event.type === "message" || event.type === "history_row" || event.type === "tool_start" || event.type === "tool_end") return s;
      }
      if (s.phase !== "chat") return s;
      if (event.type === "history_row") {
        const messages = [...s.messages, { role: event.role, text: event.text } as ChatMessage];
        messagesRef.current = messages;
        return { ...s, messages };
      }
      if (event.type === "browser_control") {
        return s.phase === "chat" ? { ...s, browserHeld: event.held } : s;
      }
      if (event.type === "browser_status") {
        return s.phase === "chat" ? { ...s, browserUrl: event.url, browserTitle: event.title } : s;
      }
      if (event.type === "message" && (event.role === "user" || event.role === "assistant")) {
        const messages = [...s.messages, { role: event.role, text: event.text }];
        messagesRef.current = messages;
        return {
          ...s,
          streaming: event.role === "assistant" ? "" : s.streaming,
          messages,
          error: undefined,
        };
      }
      if (event.type === "tool_start") {
        const messages = [...s.messages, { role: "tool", text: `⚙️ ${event.tool} ${JSON.stringify(event.args ?? {}).slice(0, 140)}`, tool: { name: event.tool, args: event.args ?? {} } } as ChatMessage];
        messagesRef.current = messages;
        return { ...s, messages };
      }
      if (event.type === "tool_end") {
        const result = JSON.stringify(event.result ?? "").slice(0, 100);
        const messages = [...s.messages, { role: "tool", text: `${event.isError ? "⛔" : "✔"} ${event.tool} → ${result}`, tool: { name: event.tool, result: event.result ?? "", isError: event.isError } } as ChatMessage];
        return { ...s, messages };
      }
      if (event.type === "approval") {
        const messages = [...s.messages, { role: "tool", text: `${event.approved ? "🔓" : "⛔"} ${event.tool} ${event.approved ? "approved" : "denied"} by user` } as ChatMessage];
        return {
          ...s,
          messages,
          pendingApproval: s.pendingApproval?.callId === event.callId ? undefined : s.pendingApproval,
        };
      }
      if (event.type === "approval_request") {
        return { ...s, pendingApproval: { callId: event.callId, tool: event.tool, input: event.input } };
      }
      if (event.type === "run_settled") return s; // the transport finishes its stream
      // Deltas and tool activity render inside the assistant-ui thread. 
      if (event.type === "error") return { ...s, error: event.message };
      if (event.type === "sleep") {
        connRef.current?.close();
        // No /stop relay: the enclave's death flare owns the platform stop
        // (timer table on the concierge) — the client just renders asleep.
        return { phase: "asleep", waking: false, note: event.reason };
      }
      return s;
    });
  }, []);

  // (Machine backups are the enclave's own job now — it shelves itself
  //  every 10 minutes and once more before the sleep gate exits. The
  //  client's only role was the one-shot grant, built at unlock below.)

  // Open the account store when signed in (scope = personal space).
  useEffect(() => {
    if (!bb.isAuthenticated || !bb.session) {
      setBbStore(null);
      return;
    }
    let disposed = false;
    const spaceId = bb.personalSpaceId ?? bb.session.getPersonalSpaceId?.() ?? null;
    if (!spaceId) return;
    const ready = openAccountStore(spaceId)
      .then((store) => {
        if (disposed) return null;
        setBbStore(store);
        // The files API requires uploads to reference a real record — make
        // sure the anchor row exists (created once, never updated).
        void ensureMachineAnchor(store, spaceId);
        return store;
      })
      .catch((e) => {
        console.warn("betterbase store failed to open", e);
        return null;
      });
    bbStoreReadyRef.current = ready;
    return () => {
      disposed = true;
    };
  }, [bb.isAuthenticated, bb.session, bb.personalSpaceId]);

  const doUnlock = useCallback(
    async (result: AttestationResult) => {
      setState({ phase: "unlocking" });
      try {
        setInferenceKey(keyInput);
        attestedClientRef.current = result.client;
        // The bb session hydrates async from storage — an unlock racing it
        // would silently shelf nothing all session. Wait briefly for it to
        // settle (signed-in or not) before building the grant.
        if (bbLoadingRef.current) {
          await new Promise<void>((resolve) => {
            const settle = () => {
              clearInterval(poll);
              clearTimeout(t);
              resolve();
            };
            const t = setTimeout(settle, 3_000);
            const poll = setInterval(() => {
              if (!bbLoadingRef.current) settle();
            }, 100);
          });
        }
        // The machine-shelf grant: scoped betterbase credentials so the
        // enclave can shelf + restore its own backups (epoch key wrapped
        // under the unlock secret — memory-only both sides).
        const grant = await buildBbGrant(
          bb.session,
          bb.personalSpaceId,
          await resolveSyncEndpoint(),
        );
        await unlock(result.client, activeEnclave, keyInput || undefined, grant ?? undefined);
        await getState(result.client, activeEnclave);
        const transport = transportRef.current!;
        transport.setAppTap((e) => onServerEvent(e));
        const conn = connectChat(
          activeEnclave,
          getToken() ?? "",
          (event) => transport.dispatch(event),
          () => {
            transport.detach();
            setState((s) => (s.phase === "chat" ? { ...s, connected: false } : s));
          },
        );
        connRef.current = conn;
        transport.attach((intent) => conn.send(intent));
        // Fresh boot (scratch wiped): hydrate from the user's betterbase
        // store first, relay the rows into the enclave's sealed log, and
        // seed the surface. Device snapshot is the signed-out fallback.
        const state2 = await getState(result.client, activeEnclave);
        // Sleep wipes the scratch: a post-wake log may hold only bookkeeping
        // (the sleep marker). Only history-bearing rows count for seeding.
        const historyEvents = state2.events.filter((e) => e.type !== "sleep");
        let seed: ChatMessage[] = [];
        if (historyEvents.length > 0) {
          // The log already holds the history — seed from it directly and
          // suppress the ws backlog's duplicate rows (cleared on replay_done,
          // with a failsafe so live events can never be eaten).
          seed = eventsToRows(historyEvents);
          suppressReplayRef.current = seed.length > 0;
          setTimeout(() => (suppressReplayRef.current = false), 8000);
        }
        if (historyEvents.length === 0) {
          // Fresh scratch with no shelf backup — a genuinely new machine.
          // (When the enclave had a grant, it restored itself inside the
          //  unlock call above: the history it pulled back from betterbase
          //  already shows up in state2, and this branch is skipped.)
        }
        messagesRef.current = seed;
        setState({
          phase: "chat",
          result,
          messages: seed,
          streaming: "",
          connected: true,
          replayed: historyEvents.length > 0 ? false : true,
        });
      } catch (e) {
        setState({ phase: "error", message: `unlock: ${e instanceof Error ? e.message : String(e)}` });
      }
    },
    [keyInput, onServerEvent, bb.session, bb.personalSpaceId],
  );
  // Auto-resume: a stored token and an unlocked enclave mean a refresh —
  // reconnect, replay, continue. No manual click required.
  useEffect(() => {
    if (state.phase === "attested" && !state.locked && getToken() && keyInput) {
      void doUnlock(state.result);
    }
  }, [state, doUnlock, keyInput]);

  /** The user's hands: transient input intents over the live ws. */
  const sendBrowserInput = useCallback(
    (intent: { type: "browser_input"; events: InputEvent[] } | { type: "browser_release" }) => {
      connRef.current?.send(intent);
    },
    [],
  );
  const releaseBrowser = useCallback(() => {
    connRef.current?.send({ type: "browser_release" });
    setState((s) => (s.phase === "chat" ? { ...s, browserHeld: false } : s));
  }, []);

  const wake = useCallback((note = "concierge booting the instance…") => void wakeCore(note), []);

  // History seed for the runtime: computed once when the backlog finishes.
  // Identity must stay stable afterward — a fresh array per render makes the
  // runtime re-sync and wipe live streaming turns.
  const chatState = state.phase === "chat" ? state : null;
  const replayedNow = chatState?.replayed ?? false;
  const seedMessages = useMemo(() => {
    const rows = chatState?.messages ?? [];
    const out: UIMessage[] = [];
    let assistantParts: UIMessage["parts"] = [];
    const flush = (id: string) => {
      if (assistantParts.length > 0) out.push({ id, role: "assistant", parts: assistantParts });
      assistantParts = [];
    };
    for (let i = 0; i < rows.length; i++) {
      const m = rows[i]!;
      if (m.role === "user") {
        flush(`h${i}a`);
        out.push({ id: `h${i}`, role: "user", parts: [{ type: "text", text: m.text }] });
        continue;
      }
      if (m.role === "tool" && m.tool) {
        // A completed call pairs its start row (args) with its end row
        // (result) into one dynamic-tool part — same chip the live stream
        // renders. Start-only rows (crash/interrupt) ride as input-available.
        const next = rows[i + 1];
        const start = m.tool.result === undefined ? m.tool : undefined;
        if (start && next?.role === "tool" && next.tool?.name === m.tool.name && next.tool.result !== undefined) {
          assistantParts.push({
            type: "dynamic-tool",
            toolName: m.tool.name,
            toolCallId: `h${i}`,
            state: next.tool.isError ? "output-error" : "output-available",
            input: m.tool.args ?? {},
            ...(next.tool.isError
              ? { errorText: String(next.tool.result ?? "").slice(0, 200) }
              : { output: next.tool.result ?? "" }),
          } as UIMessage["parts"][number]);
          i++; // consumed the end row
          continue;
        }
        if (start) {
          assistantParts.push({
            type: "dynamic-tool",
            toolName: m.tool.name,
            toolCallId: `h${i}`,
            state: "input-available",
            input: m.tool.args ?? {},
          } as UIMessage["parts"][number]);
          continue;
        }
        // End row whose start was already consumed or absent.
        assistantParts.push({
          type: "dynamic-tool",
          toolName: m.tool.name,
          toolCallId: `h${i}e`,
          state: m.tool.isError ? "output-error" : "output-available",
          input: {},
          ...(m.tool.isError
            ? { errorText: String(m.tool.result ?? "").slice(0, 200) }
            : { output: m.tool.result ?? "" }),
        } as UIMessage["parts"][number]);
        continue;
      }
      // Plain assistant text, or legacy tool rows without structure.
      assistantParts.push({ type: "text", text: m.role === "tool" ? `\`${m.text}\`` : m.text });
    }
    flush("hz");
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replayedNow]);

  const answerApproval = useCallback(
    (approved: boolean) => {
      if (state.phase !== "chat" || !state.pendingApproval || !connRef.current) return;
      connRef.current.send({ type: "approval_response", callId: state.pendingApproval.callId, approved });
    },
    [state],
  );

  const tree = (
    <div className="flex h-full flex-col">
      {state.phase !== "chat" ? (
        <div className="flex-1 overflow-auto">
          {state.phase === "verifying" && <VerifyingScreen />}
          {state.phase === "error" && (
            <ErrorScreen
              message={state.message}
              onRetry={() => void run()}
              onForget={() => { forgetSecret(); void run(); }}
              onWake={() => void wake()}
            />
          )}
          {state.phase === "blocked" && (
            <BlockedScreen
              pinned={fp(state.result.pinConflict!.pinned)}
              current={fp(state.result.pinConflict!.current)}
              releaseTag={state.result.releaseTag}
              releaseDigest={fp(state.result.releaseDigest)}
              onApprove={() => { repin(state.result); void run(); }}
            />
          )}
          {state.phase === "attested" && state.locked && (
            <LockedForm
              keyInput={keyInput}
              onKeyInput={setKeyInput}
              hasStoredSecret={!!getToken()}
              onUnlock={() => void doUnlock(state.result)}
            />
          )}
          {state.phase === "attested" && !state.locked && (
            <AttestedScreen
              releaseTag={DEV ? "DEV" : state.result.releaseTag}
              firstPin={state.result.firstPin}
              locked={false}
              onUnlock={() => void doUnlock(state.result)}
              onResume={() => void doUnlock(state.result)}
            />
          )}
          {state.phase === "unlocking" && <UnlockingScreen />}
          {state.phase === "asleep" && (
            <AsleepScreen waking={state.waking} note={state.note} onWake={() => void wake()} />
          )}
          <StoreFooter
            connected={bb.isAuthenticated}
            handle={bb.handle ?? undefined}
            opening={!!bbStore || !bb.isAuthenticated ? false : true}
            onConnect={bb.clientId ? () => void bb.login() : undefined}
          />
        </div>
      ) : (
        <Shell
          browserLive={!!state.frameLive}
          onSleep={() => {
            // The enclave shelves its own final checkpoint inside the sleep
            // gate — nothing to push from here. Just tell it to go down.
            frameBus.reset();
            frameLiveRef.current = false;
            connRef.current?.send({ type: "sleep_now" });
          }}
          statusChips={
            <>
              <Chip tone="good">
                {DEV ? "dev parity" : `attested · ${state.result.releaseTag}`}
              </Chip>
              <Chip tone={state.connected ? "good" : "warn"}>
                {state.connected ? "stream live" : "disconnected — reload"}
              </Chip>
              {state.frameLive && <Chip tone="duck">👁 eyes on</Chip>}
            </>
          }
          browser={
            <BrowserDock
              url={state.browserUrl}
              title={state.browserTitle}
              onExpand={() => setBrowserExpanded(true)}
              held={state.browserHeld === true}
              onRelease={releaseBrowser}
              send={sendBrowserInput}
            />
          }
        >
          {state.pendingApproval && (
            <ApprovalCard
              tool={state.pendingApproval.tool}
              input={state.pendingApproval.input}
              onAnswer={answerApproval}
            />
          )}
          {state.replayed ? (
            <div className="min-h-0 flex-1 overflow-hidden rounded-2xl border border-border/60 bg-card/40">
              <ChatSurface transport={transportRef.current!} initialMessages={seedMessages} />
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
              <span className="animate-pulse">replaying history…</span>
            </div>
          )}
          {state.error && (
            <div className="mt-2 rounded-xl border border-gate-strong/50 bg-gate-strong/10 px-4 py-2.5 text-sm text-gate-strong">
              ⛔ {state.error}
            </div>
          )}
        </Shell>
      )}
      {state.phase === "chat" && browserExpanded && (
        <BrowserOverlay
          url={state.browserUrl}
          title={state.browserTitle}
          onClose={() => setBrowserExpanded(false)}
          held={state.browserHeld === true}
          onRelease={releaseBrowser}
          send={sendBrowserInput}
        />
      )}
    </div>
  );

  // The sync engine mounts with the account store: pushes pending local
  // puts, pulls server records into the local db. Without it the store is
  // local-only (which is also why the device snapshot stays a fallback).
  const bbClientId = import.meta.env.VITE_BETTERBASE_CLIENT_ID ?? "";
  const bbDomain = import.meta.env.VITE_BETTERBASE_DOMAIN ?? "localhost:5377";
  if (bbStore && bb.session) {
    return (
      <BetterbaseProvider
        adapter={bbStore.db}
        collections={COLLECTIONS}
        session={bb.session}
        clientId={bbClientId}
        domain={bbDomain}
        fileStore={bbStore.fileStore}
      >
        {tree}
      </BetterbaseProvider>
    );
  }
  return tree;
}
