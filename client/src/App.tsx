import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { verifyEnclave, repin, type AttestationResult } from "./lib/attestation";
import { unlock, getState, forgetSecret, getToken, getInferenceKey, setInferenceKey } from "./lib/session";
import { getBackgroundPref, setBackgroundPref, hasAcceptedWarning, acceptWarning } from "./lib/background";
import { connectChat, type ServerEvent, type ChatConnection } from "./lib/ws";
import {
  openAccountStore,
  ensureMachineAnchor,
  type AccountStore,
} from "./lib/betterbase-store";
import type { UIMessage } from "@ai-sdk/react";
import { ChatSurface } from "./components/ChatSurface";
import { BrowserDock, BrowserOverlay } from "./components/BrowserDock";
import type { BrowserSend } from "./components/InteractFrame";
import { Shell, StoreFooter } from "./components/Shell";
import { Chip } from "./components/DuckMark";
import { ApprovalCard } from "./components/ApprovalCard";
import { BackgroundDialog } from "./components/BackgroundDialog";
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
import { DEV, ENCLAVE_URL, CONFIG_REPO, BB_CLIENT_ID, BB_DOMAIN } from "./lib/config";
import { eventsToRows, rowsToUIMessages, toolStartRow, toolEndRow, approvalRow, historyRow, type ChatMessage } from "./lib/history";
import { wakeInstance, pollUntilHealthy, assignStandby } from "./lib/concierge";

/** The machine this session talks to: the primary, or a warm standby
 *  handed out by the concierge's pool (same config repo → same
 *  measurement → the TOFU pin travels with it). */
let activeEnclave = ENCLAVE_URL;

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
      connected: boolean;
      replayed: boolean;
      error?: string;
      pendingApproval?: { callId: string; tool: string; input: unknown };
      frameLive?: boolean;
      browserUrl?: string;
      browserTitle?: string;
      browserHeld?: boolean;
    };

const fp = (s: string) => `${s.slice(0, 16)}…${s.slice(-8)}`;

/** The standby must live in the primary's operator domain: the TOFU pin
 *  travels by measurement, so it cannot catch a host switch. Empty on a
 *  malformed ENCLAVE_URL — the caller then skips standby assignment. */
function standbyZone(): string {
  try {
    return `.${new URL(ENCLAVE_URL).hostname.split(".").slice(1).join(".")}`;
  } catch {
    return "";
  }
}

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

export function App() {
  const [state, setState] = useState<State>({ phase: "verifying" });
  const [browserExpanded, setBrowserExpanded] = useState(false);
  const [keyInput, setKeyInput] = useState(getInferenceKey());
  const connRef = useRef<ChatConnection | null>(null);
  // Two-tier autonomy: the delegation switch + its one-time warning.
  const [background, setBackground] = useState<boolean>(getBackgroundPref() ?? false);
  const [bgDialog, setBgDialog] = useState(false);
  const transportRef = useRef<WaddleChatTransport | null>(null);
  const bb = useAuth();
  // Live view of the auth hydration flag for async flows (closures capture
  // a stale boolean; this ref tracks it across renders).
  const bbLoadingRef = useRef(bb.isLoading);
  bbLoadingRef.current = bb.isLoading;
  // Same for the session object: `run`'s empty-deps closure would otherwise
  // pin a first-render null forever — concierge auth would silently fall
  // back to the shared secret on every auto-wake/assign.
  const bbSessionRef = useRef(bb.session);
  bbSessionRef.current = bb.session;
  const conciergeAuth = useCallback(
    async (): Promise<string | null> => (await bbSessionRef.current?.getToken().catch(() => null)) ?? null,
    [],
  );
  const [bbStore, setBbStore] = useState<AccountStore | null>(null);
  // True while the ws backlog for an already-seeded log streams in — its
  // rows are in the seed, so ingesting them again would duplicate history.
  const suppressReplayRef = useRef(false);
  const frameLiveRef = useRef(false);
  const autoWokeRef = useRef(false);
  if (!transportRef.current) transportRef.current = new WaddleChatTransport();

  /** Wake through the concierge: POST the verb, poll the enclave, re-run
   *  the flow when it answers. Shared by the manual button and the
   *  load-time auto-wake (once per page load). */
  async function wakeCore(note: string) {
    setState({ phase: "asleep", waking: true, note });
    activeEnclave = ENCLAVE_URL; // the wake path always targets the primary
    const woke = await wakeInstance(conciergeAuth);
    if (!woke.ok) {
      setState((st) => (st.phase === "asleep" ? { ...st, waking: false, note: woke.detail } : st));
      return;
    }
    const healthy = await pollUntilHealthy(activeEnclave, 60, (i) =>
      setState((st) => (st.phase === "asleep" ? { ...st, note: `waiting for the enclave… (${i})` } : st)),
    );
    if (healthy) {
      void run();
      return;
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
          // instead of a ~75s deploy. Same measured config → the pin holds
          // (assignStandby zone-binds the URL so the pin CAN hold). A
          // malformed ENCLAVE_URL skips the standby path — the wake path
          // (which resets activeEnclave) is still the honest fallback.
          const zone = standbyZone();
          const standby = zone ? await assignStandby(conciergeAuth, zone) : null;
          if (standby) {
            activeEnclave = standby;
            void run(); // verify the standby; its unlock flow continues there
            return;
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
    // Echo from the server (we sent the intent, or a snapshot carried a
    // different value): keep the toggle truthful, remember the choice.
    if (event.type === "preference") {
      setBackgroundPref(event.background);
      setBackground(event.background);
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
      if (suppressReplayRef.current) {
        // Backlog duplicate of the seeded history — drop.
        if (event.type === "message" || event.type === "history_row" || event.type === "tool_start" || event.type === "tool_end") return s;
      }
      if (s.phase !== "chat") return s;
      if (event.type === "history_row") {
        const messages = [...s.messages, historyRow(event.role, event.text)];
        return { ...s, messages };
      }
      if (event.type === "browser_control") {
        return { ...s, browserHeld: event.held };
      }
      if (event.type === "browser_status") {
        return { ...s, browserUrl: event.url, browserTitle: event.title };
      }
      if (event.type === "message" && (event.role === "user" || event.role === "assistant")) {
        const messages = [...s.messages, { role: event.role, text: event.text }];
        return { ...s, messages, error: undefined };
      }
      if (event.type === "tool_start") {
        const messages = [...s.messages, toolStartRow(event.tool, event.args ?? {})];
        return { ...s, messages };
      }
      if (event.type === "tool_end") {
        const messages = [...s.messages, toolEndRow(event.tool, event.result ?? "", event.isError)];
        return { ...s, messages };
      }
      if (event.type === "approval") {
        const messages = [...s.messages, approvalRow(event.tool, event.approved)];
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
    openAccountStore(spaceId)
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
    return () => {
      disposed = true;
    };
  }, [bb.isAuthenticated, bb.session, bb.personalSpaceId]);

  const doUnlock = useCallback(
    async (result: AttestationResult) => {
      setState({ phase: "unlocking" });
      try {
        setInferenceKey(keyInput);
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
        const unlocked = await unlock(
          result.client,
          activeEnclave,
          keyInput || undefined,
          grant ?? undefined,
          getBackgroundPref() ?? undefined,
        );
        // Fresh device (no local choice): adopt the machine's copy — the
        // preference rides the snapshot, so it already survived boots. A
        // true value means the user accepted the warning on another
        // device (the snapshot carried the acceptance), so recording it
        // here is accurate, not a bypass.
        if (getBackgroundPref() === null && typeof unlocked.background === "boolean") {
          if (unlocked.background) acceptWarning();
          else setBackgroundPref(false);
          setBackground(unlocked.background);
        }
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
        setState({
          phase: "chat",
          result,
          messages: seed,
          connected: true,
          replayed: historyEvents.length === 0,
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
  const sendBrowserInput = useCallback<BrowserSend>(
    (intent) => {
      connRef.current?.send(intent);
    },
    [],
  );
  const releaseBrowser = useCallback(() => {
    connRef.current?.send({ type: "browser_release" });
    setState((s) => (s.phase === "chat" ? { ...s, browserHeld: false } : s));
  }, []);

  /** The delegation switch. Enabling without a prior acceptance opens the
   *  one-time warning; every change reaches the machine immediately (the
   *  unlock payload carries it as backup) and persists locally. */
  const toggleBackground = useCallback(() => {
    const next = !background;
    if (next && !hasAcceptedWarning()) {
      setBgDialog(true); // tier 0 → tier 1 needs the warned opt-in, once
      return;
    }
    setBackgroundPref(next);
    setBackground(next);
    connRef.current?.send({ type: "preference", background: next });
  }, [background]);

  const wake = useCallback((note = "concierge booting the instance…") => void wakeCore(note), []);

  // History seed for the runtime: computed once when the backlog finishes.
  // Identity must stay stable afterward — a fresh array per render makes the
  // runtime re-sync and wipe live streaming turns.
  const chatState = state.phase === "chat" ? state : null;
  const replayedNow = chatState?.replayed ?? false;
  const seedMessages = useMemo(
    () => rowsToUIMessages(chatState?.messages ?? []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [replayedNow],
  );

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
            opening={bb.isAuthenticated && !bbStore}
            onConnect={bb.clientId ? () => void bb.login() : undefined}
          />
        </div>
      ) : (
        <Shell
          browserLive={!!state.frameLive}
          background={background}
          onToggleBackground={toggleBackground}
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
      {bgDialog && (
        <BackgroundDialog
          onAccept={() => {
            acceptWarning();
            setBackground(true);
            connRef.current?.send({ type: "preference", background: true });
            setBgDialog(false);
          }}
          onCancel={() => setBgDialog(false)}
        />
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
  const bbClientId = BB_CLIENT_ID;
  const bbDomain = BB_DOMAIN;
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
