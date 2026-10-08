import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { verifyEnclave, repin, type AttestationResult } from "./lib/attestation";
import { unlock, getState, forgetSecret, getToken, getInferenceKey, setInferenceKey } from "./lib/session";
import { connectChat, type ServerEvent, type ChatConnection } from "./lib/ws";
import { saveSnapshot, loadSnapshot } from "./lib/backup";
import { getSecret } from "./lib/session";
import type { StateResponse } from "@waddle/sdk";
import type { UIMessage } from "@ai-sdk/react";
import { ChatSurface } from "./ChatSurface";
import { BrowserDock, BrowserOverlay } from "./components/BrowserDock";
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
import {
  openAccountStore,
  putSnapshot,
  readSnapshot,
  type AccountStore,
} from "./lib/betterbase-store";
import { sealSnapshot, openSnapshot, type SealedSnapshot } from "./lib/backup";
import { WaddleChatTransport } from "./lib/waddle-transport";

const DEV = import.meta.env.VITE_DEV === "1";
const ENCLAVE_URL =
  import.meta.env.VITE_ENCLAVE_URL ?? "https://waddle.ddg-waddle.containers.tinfoil.dev";
const CONFIG_REPO = import.meta.env.VITE_CONFIG_REPO ?? "nchapman/waddle-config";
const CONCIERGE_URL = import.meta.env.VITE_CONCIERGE_URL ?? "http://localhost:5390";
const CONCIERGE_TOKEN = import.meta.env.VITE_CONCIERGE_TOKEN ?? "waddle-dev";

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
      frame?: string | null;
      browserUrl?: string;
      browserTitle?: string;
      frameSeq?: number;
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
  const [bbStore, setBbStore] = useState<AccountStore | null>(null);
  const bbStoreReadyRef = useRef<Promise<AccountStore | null> | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  const genRef = useRef(0);
  const pushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // onServerEvent is a []-deps callback; it must see the *current* push
  // function (bbStore resolves after mount), so it reads through this ref.
  const pushFnRef = useRef<() => void>(() => {});
  // True while the ws backlog for an already-seeded log streams in — its
  // rows are in the seed, so ingesting them again would duplicate history.
  const suppressReplayRef = useRef(false);
  if (!transportRef.current) transportRef.current = new WaddleChatTransport();

  const run = useCallback(async () => {
    setState({ phase: "verifying" });
    try {
      if (DEV) {
        const res = await fetch(`${ENCLAVE_URL}/health`);
        const health = (await res.json()) as { locked: boolean };
        setState({ phase: "attested", result: DEV_RESULT, locked: health.locked });
        return;
      }
      const result = await verifyEnclave(ENCLAVE_URL, CONFIG_REPO);
      if (result.pinConflict) {
        setState({ phase: "blocked", result });
        return;
      }
      const res = await result.client.fetch(`${ENCLAVE_URL}/health`);
      const health = (await res.json()) as { locked: boolean };
      setState({ phase: "attested", result, locked: health.locked });
    } catch (e) {
      setState({ phase: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  useEffect(() => {
    void run();
    return () => connRef.current?.close();
  }, [run]);


  const onServerEvent = useCallback((event: ServerEvent) => {
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
      if (event.type === "frame") {
        return s.phase === "chat" ? { ...s, frame: event.data, frameSeq: event.seq } : s;
      }
      if (event.type === "browser_status") {
        return s.phase === "chat" ? { ...s, browserUrl: event.url, browserTitle: event.title } : s;
      }
      if (event.type === "message" && (event.role === "user" || event.role === "assistant")) {
        const messages = [...s.messages, { role: event.role, text: event.text }];
        messagesRef.current = messages;
        pushFnRef.current();
        // Device snapshot (fallback) after every sealed message.
        void saveSnapshot(getSecret(), messages);
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
        pushFnRef.current();
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
        // Relay the platform-level stop through the concierge (the enclave
        // holds no lifecycle credentials by design — the operator service
        // holds the scoped key; we see who stopped what, never content).
        void fetch(`${CONCIERGE_URL}/stop`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${CONCIERGE_TOKEN}` },
          body: JSON.stringify({ instance: "waddle" }),
        }).catch(() => undefined);
        return { phase: "asleep", waking: false, note: event.reason };
      }
      return s;
    });
  }, []);

  /** Checkpoint to the user's betterbase store (debounced; sealed envelope). */
  const scheduleBetterbasePush = useCallback(() => {
    if (pushTimer.current) clearTimeout(pushTimer.current);
    pushTimer.current = setTimeout(() => {
      const store = bbStore;
      const secret = getSecret();
      if (!store || !secret || messagesRef.current.length === 0) return;
      void (async () => {
        try {
          const sealed: SealedSnapshot = await sealSnapshot(secret, messagesRef.current, genRef.current);
          genRef.current = sealed.gen;
          await putSnapshot(store, JSON.stringify(sealed), sealed.gen);
        } catch (e) {
          console.warn("betterbase push failed", e);
        }
      })();
    }, 800);
  }, [bbStore]);

  pushFnRef.current = scheduleBetterbasePush;

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
        await unlock(result.client, ENCLAVE_URL, keyInput || undefined);
        await getState(result.client, ENCLAVE_URL);
        const transport = transportRef.current!;
        transport.setAppTap((e) => onServerEvent(e));
        const conn = connectChat(
          ENCLAVE_URL,
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
        const state2 = await getState(result.client, ENCLAVE_URL);
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
          const secret = getSecret() ?? "";
          let pulled: ChatMessage[] | null = null;
          // The store opens async (workers + OPFS) and the auth context may
          // still be settling when auto-resume fires doUnlock. Poll for the
          // store promise — but only when a betterbase session exists, so
          // signed-out unlocks never wait.
          const hasBbSession = () =>
            Object.keys(localStorage).some((k) => k.startsWith("betterbase_session_waddle_"));
          const store = bbStore ?? (await new Promise<AccountStore | null>((resolve) => {
            if (!hasBbSession()) return resolve(null);
            const deadline = Date.now() + 5000;
            (function tick() {
              const ready = bbStoreReadyRef.current;
              if (ready) return void ready.then(resolve);
              if (Date.now() > deadline) return resolve(null);
              setTimeout(tick, 60);
            })();
          }));
          if (store && secret) {
            try {
              const blob = await readSnapshot(store);
              if (blob) pulled = await openSnapshot(secret, JSON.parse(blob) as SealedSnapshot);
            } catch (e) {
              console.warn("betterbase pull failed", e);
            }
          }
          const relayHistory = async (rows: ChatMessage[]) => {
            // The ws may still be handshaking (or reconnecting) when the
            // pull finishes; retry until the frame actually goes out.
            for (let i = 0; i < 40; i++) {
              const target = connRef.current;
              if (!target) break;
              try {
                target.send({
                  type: "history_restore",
                  rows: rows.map((m) => ({ role: m.role, text: m.text })),
                });
                return;
              } catch {
                await new Promise((r) => setTimeout(r, 250));
              }
            }
            throw new Error("history_restore: connection never opened");
          };
          if (pulled && pulled.length > 0) {
            await relayHistory(pulled);
            seed = pulled;
          } else {
            seed = (await loadSnapshot(secret)) ?? [];
            if (seed.length > 0) await relayHistory(seed);
          }
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
    [keyInput, onServerEvent],
  );
  // Auto-resume: a stored token and an unlocked enclave mean a refresh —
  // reconnect, replay, continue. No manual click required.
  useEffect(() => {
    if (state.phase === "attested" && !state.locked && getToken() && keyInput) {
      void doUnlock(state.result);
    }
  }, [state, doUnlock, keyInput]);

  const wake = useCallback(async () => {
    setState({ phase: "asleep", waking: true, note: "concierge booting the instance…" });
    try {
      await fetch(`${CONCIERGE_URL}/wake`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${CONCIERGE_TOKEN}` },
        body: JSON.stringify({ instance: "waddle" }),
      });
    } catch {
      setState((st) => (st.phase === "asleep" ? { ...st, note: "concierge unreachable — is it running?" } : st));
      return;
    }
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const res = await fetch(`${ENCLAVE_URL}/health`, { signal: AbortSignal.timeout(4000) });
        if (res.ok) {
          void run();
          return;
        }
      } catch {
        /* still booting */
      }
      setState((st) => (st.phase === "asleep" ? { ...st, note: `waiting for the enclave… (${i + 1})` } : st));
    }
    setState((st) => (st.phase === "asleep" ? { ...st, note: "gave up waiting — try again" } : st));
  }, [run]);

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
          browserLive={!!state.frame}
          onSleep={() => {
            // Final checkpoint before exit: seal + push now (no debounce),
            // then sleep. If the push loses the race, the record stays
            // dirty locally and syncs on the next connect — durable either way.
            if (pushTimer.current) clearTimeout(pushTimer.current);
            const store = bbStore;
            const secret = getSecret();
            if (store && secret && messagesRef.current.length > 0) {
              void sealSnapshot(secret, messagesRef.current, genRef.current)
                .then((sealed) => {
                  genRef.current = sealed.gen;
                  return putSnapshot(store, JSON.stringify(sealed), sealed.gen);
                })
                .catch((e) => console.warn("betterbase sleep push failed", e));
            }
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
              {state.frame && <Chip tone="duck">👁 eyes on</Chip>}
            </>
          }
          browser={
            <BrowserDock
              frame={state.frame ?? null}
              url={state.browserUrl}
              title={state.browserTitle}
              onExpand={() => setBrowserExpanded(true)}
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
          frame={state.frame ?? null}
          url={state.browserUrl}
          title={state.browserTitle}
          onClose={() => setBrowserExpanded(false)}
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
