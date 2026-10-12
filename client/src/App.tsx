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
import { DEV, ENCLAVE_URL, CONFIG_REPO, BB_CLIENT_ID, BB_DOMAIN, ZONE } from "./lib/config";
import { eventsToRows, rowsToUIMessages, toolStartRow, toolEndRow, approvalRow, historyRow, type ChatMessage } from "./lib/history";
import { pollUntilHealthy, bootInstance, awaitMachineReady } from "./lib/concierge";

/** The machine /boot gave us — the ONLY live enclave target (no baked
 *  URL: a hardcoded primary was the tier-mix root, proof 9). */
let activeEnclave = DEV ? ENCLAVE_URL : "";

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
  // back to the shared secret on every auto-boot.
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
  /** Discovery ran this page load. A machine that fails verification
   *  AFTER discovery gets the error screen, not another discovery —
   *  /boot would hand back the same failing machine and loop forever
   *  (review-caught). */
  const discoveryTriedRef = useRef(false);
  /** The client WATCHED a machine die in-session (unreachable mid-flow,
  *  or its boot poll gave up): its name may sit poisoned in the
  *  browser's DNS cache for the negative TTL — the next wake asks for a
  *  FRESH name instead of rebinding into the poison. Blank machines are
  *  cattle; the shelf holds all state. */
  const machineDiedRef = useRef(false);
  if (!transportRef.current) transportRef.current = new WaddleChatTransport();

  /** Wake through the concierge: POST the verb, poll the enclave, re-run
   *  the flow when it answers. Shared by the manual button and the
   *  load-time auto-wake (once per page load).
   *
   *  Live mode is discovery-first: /boot asks the concierge for MY
   *  machine (per-user cattle name, warm from the pool when possible).
   *  Dev compose is always-on and skips the concierge entirely. */
  async function wakeCore(note: string) {
    setState({ phase: "asleep", waking: true, note });
    if (DEV) {
      // Dev compose is always-on: no concierge, no boot — just the agent.
      const healthy = await pollUntilHealthy(activeEnclave, 30, (i) =>
        setState((st) => (st.phase === "asleep" ? { ...st, note: `waiting for the agent… (${i})` } : st)),
      );
      if (healthy) void run();
      else setState((st) => (st.phase === "asleep" ? { ...st, waking: false, note: "compose stack not answering — docker compose up?" } : st));
      return;
    }
    // Wait for the betterbase session to hydrate (audit critical):
    // App's mount effect runs BEFORE AuthProvider's restore, so a
    // first-load /boot would deterministically fire with no token and
    // die on "no betterbase session" while the footer says connected.
    // Same ≤3s settle doUnlock uses for the identical race.
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
    const booted = await bootInstance(conciergeAuth, 300_000, undefined, machineDiedRef.current);
    if (booted.ok && booted.url) {
      discoveryTriedRef.current = true;
      machineDiedRef.current = false;
      activeEnclave = booted.url;
      // ALWAYS gate through the concierge before touching the machine's
      // name — even when /boot said "running" (a table row is not a DNS
      // fact; a stale row or resolver lag would otherwise poison the
      // browser's resolver with a 30-min NXDOMAIN). awaitMachineReady:
      // concierge re-verifies status + DNS first, health second.
      const { healthy } = await awaitMachineReady(
        conciergeAuth,
        { url: booted.url, instance: booted.instance, waking: booted.waking },
        (note) => setState((st) => (st.phase === "asleep" ? { ...st, note } : st)),
      );
      if (healthy) {
        void run();
        return;
      }
      machineDiedRef.current = true; // never reached health — assume the worst for the next wake
      setState((st) => (st.phase === "asleep" ? { ...st, waking: false, note: "gave up waiting — try again" } : st));
      return;
    }
    // Discovery is the ONLY live path (no legacy primary fallback — the
    // fallback was the tier-mix bug: a bb JWT on the primary taught it a
    // dead sibling's name, proof 9). A /boot failure means what it says:
    // no session is a dead end; anything else (concierge down, refused,
    // out-of-zone) is an honest operator-visible error.
    if (booted.detail?.startsWith("no betterbase session")) {
      setState((st) => (st.phase === "asleep" ? { ...st, waking: false, note: booted.detail } : st));
      return;
    }
    setState((st) => (st.phase === "asleep" ? { ...st, waking: false, note: booted.detail ?? "boot failed" } : st));
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
      // error screen — waking can't help those (and a spurious /boot would
      // stop-and-redeploy a healthy machine via zombie recovery).
      if (!DEV && !discoveryTriedRef.current) {
        // Auto-retry on NO machine yet (first load — nothing to verify)
        // or genuine unreachability: a machine that answers /health but
        // fails attestation/config is live-but-wrong — the error screen
        // (an ensure() on it is the zombie-redeploy class). Unreachable
        // = the machine died mid-flow — ONE retry via discovery
        // (rebind/re-mint), then the honest error. The tried-ref breaks
        // the loop.
        if (!activeEnclave) {
          void wakeCore("no machine yet — discovering");
          return;
        }
        let unreachable = false;
        try {
          await fetch(`${activeEnclave}/health`, { signal: AbortSignal.timeout(2500) });
        } catch {
          unreachable = true;
        }
        if (unreachable) {
          void wakeCore("enclave unreachable — discovering my machine");
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

  // Sign-in → wake, hands free: the first-run card's whole job is "sign in
  // and your agent appears". Fires once per auth transition while the app
  // still sits asleep (a failed wake lands on the failed card — retry is
  // a click, not an auto-loop).
  const authedRef = useRef(bb.isAuthenticated);
  useEffect(() => {
    if (authedRef.current === bb.isAuthenticated) return;
    authedRef.current = bb.isAuthenticated;
    if (bb.isAuthenticated) {
      setState((st) =>
        st.phase === "asleep" && !st.waking ? { ...st, waking: true, note: undefined } : st,
      );
      if (state.phase === "asleep") void wake("signed in — waking your machine");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bb.isAuthenticated]);


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
      // A turn this client is streaming renders through its own stream — its
      // user echo, tool rows, verdicts, and final all arrive via the
      // broadcast as well, and appending them would duplicate the thread
      // AND hand the runtime a mid-stream re-seed (the wipe hazard). Idle
      // clients append instead: a scheduled nudge fired while they watch,
      // another browser's words, the tools of a watched fire. The sealed
      // log keeps the authoritative rows for the next replay either way.
      const streaming = transportRef.current?.isStreaming();
      if (
        streaming &&
        (event.type === "message" ||
          event.type === "history_row" ||
          event.type === "tool_start" ||
          event.type === "tool_end")
      )
        return s;
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
        // The verdict ROW renders in the streamer's own turn (fenced text
        // via the transport) and in idle watchers' threads (an approvalRow
        // in their collected turn); this state append is for the pre-mount
        // backlog only. Clearing the card is state cleanup — always runs.
        const messages = streaming ? s.messages : [...s.messages, approvalRow(event.tool, event.approved)];
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

  // Auto-unlock, same logic: a stored secret on a returning device makes the
  // unlock click ceremony, not proof — hand it over and go. Fresh devices
  // (no stored secret) keep the full form. One attempt per attested cycle;
  // a failure lands on the error screen, not a retry loop.
  const autoUnlockRef = useRef(false);
  useEffect(() => {
    if (state.phase !== "attested") {
      autoUnlockRef.current = false;
      return;
    }
    if (!state.locked || autoUnlockRef.current || !getToken()) return;
    autoUnlockRef.current = true;
    void doUnlock(state.result);
  }, [state, doUnlock]);

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

  /** The asleep journey as the user sees it: sign-in first, then staged
   *  progress (the note strings are ours — mapped, not parsed from the
   *  platform), then an actionable failure. Raw notes ride as `detail`. */
  function asleepStage(
    st: { waking: boolean; note?: string },
    authed: boolean,
    bbLoading: boolean,
  ): "signin" | "idle" | "finding" | "waking" | "verifying" | "failed" {
    if (!authed && !bbLoading) return "signin";
    if (st.waking) {
      if (st.note?.startsWith("waiting for the enclave")) return "waking";
      if (st.note?.startsWith("waking the agent") || st.note?.startsWith("waiting for the agent")) return "verifying";
      return "finding";
    }
    return st.note ? "failed" : "idle";
  }

  // History seed for the runtime: computed ONCE when the backlog finishes
  // (ChatSurface mounts on `replayed`, consumes initialMessages exactly
  // once). Live turns flow through the transport only — a local submit
  // streams; a turn nobody here submitted arrives via onServerRows.
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
            <AsleepScreen
              stage={asleepStage(state, bb.isAuthenticated, bb.isLoading)}
              detail={state.note}
              onWake={() => void wake()}
              onSignIn={bb.clientId ? () => void bb.login() : undefined}
            />
          )}
        </div>
      ) : (
        <div className="min-h-0 flex-1">
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
        </div>
      )}
      {/* Pinned in EVERY phase — the store connection is the user's data
          story and the reconnect affordance; it scrolled below the fold
          once (live-caught: the only sign-in link was unreachable on a
          short viewport) and vanished entirely during chat. Hidden only
          on the first-run sign-in card, where a second sign-in affordance
          is duplicate noise (and where the card points to the footer if
          there's no betterbase client, so that path keeps it). */}
      {!(state.phase === "asleep" && bb.clientId && !bb.isAuthenticated && !bb.isLoading) && (
        <StoreFooter
          connected={bb.isAuthenticated}
          handle={bb.handle ?? undefined}
          opening={bb.isAuthenticated && !bbStore}
          onConnect={bb.clientId ? () => void bb.login() : undefined}
        />
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
