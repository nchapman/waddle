import { useCallback, useEffect, useRef, useState } from "react";
import { verifyEnclave, repin, type AttestationResult } from "./lib/attestation";
import { unlock, getState, forgetSecret, getToken, getInferenceKey, setInferenceKey } from "./lib/session";
import { connectChat, type ServerEvent, type ChatConnection } from "./lib/ws";
import { saveSnapshot, loadSnapshot } from "./lib/backup";
import { getSecret } from "./lib/session";
import type { StateResponse } from "@waddle/sdk";

const DEV = import.meta.env.VITE_DEV === "1";
const ENCLAVE_URL =
  import.meta.env.VITE_ENCLAVE_URL ?? "https://waddle.ddg-waddle.containers.tinfoil.dev";
const CONFIG_REPO = import.meta.env.VITE_CONFIG_REPO ?? "nchapman/waddle-config";
const CONCIERGE_URL = import.meta.env.VITE_CONCIERGE_URL ?? "http://localhost:5390";
const CONCIERGE_TOKEN = import.meta.env.VITE_CONCIERGE_TOKEN ?? "waddle-dev";

interface ChatMessage {
  role: "user" | "assistant";
  text: string;
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
      error?: string;
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

export function App() {
  const [state, setState] = useState<State>({ phase: "verifying" });
  const [keyInput, setKeyInput] = useState(getInferenceKey());
  const connRef = useRef<ChatConnection | null>(null);
  const [draft, setDraft] = useState("");

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
      if (s.phase !== "chat") return s;
      if (event.type === "message" && (event.role === "user" || event.role === "assistant")) {
        const messages = [...s.messages, { role: event.role, text: event.text }];
        // Device snapshot after every sealed message — sleep comes when it wants.
        void saveSnapshot(getSecret(), messages);
        return {
          ...s,
          streaming: event.role === "assistant" ? "" : s.streaming,
          messages,
          error: undefined,
        };
      }
      if (event.type === "delta") return { ...s, streaming: s.streaming + event.text };
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

  const doUnlock = useCallback(
    async (result: AttestationResult) => {
      setState({ phase: "unlocking" });
      try {
        setInferenceKey(keyInput);
        await unlock(result.client, ENCLAVE_URL, keyInput || undefined);
        await getState(result.client, ENCLAVE_URL);
        const conn = connectChat(
          ENCLAVE_URL,
          getToken() ?? "",
          onServerEvent,
          () => setState((s) => (s.phase === "chat" ? { ...s, connected: false } : s)),
        );
        connRef.current = conn;
        // The enclave's scratch is wiped at sleep; if its log is empty, the
        // device snapshot is the history. (Full server-side hydrate —
        // importFromJsonl — arrives with the betterbase snapshot work.)
        const restored = await loadSnapshot(getSecret());
        const state2 = await getState(result.client, ENCLAVE_URL);
        setState({
          phase: "chat",
          result,
          messages: state2.events.length === 0 && restored ? restored : [],
          streaming: "",
          connected: true,
        });
      } catch (e) {
        setState({ phase: "error", message: `unlock: ${e instanceof Error ? e.message : String(e)}` });
      }
    },
    [keyInput, onServerEvent],
  );

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

  const send = useCallback(() => {
    const text = draft.trim();
    if (!text || state.phase !== "chat" || !connRef.current) return;
    connRef.current.send({ type: "user_message", text });
    setDraft("");
  }, [draft, state.phase]);

  return (
    <main style={{ fontFamily: "system-ui", padding: "2rem", maxWidth: 720 }}>
      <h1>waddle</h1>

      {state.phase === "verifying" && <p style={box("#eee")}>🔒 verifying enclave…</p>}

      {state.phase === "error" && (
        <p style={box("#fde8e8")}>
          ⛔ {state.message}
          <br />
          <button onClick={() => void run()}>retry</button>{" "}
          <button onClick={() => { forgetSecret(); void run(); }}>forget secret & retry</button>{" "}
          <button onClick={() => void wake()}>☀️ wake waddle (instance may be asleep)</button>
        </p>
      )}

      {state.phase === "blocked" && (
        <div style={box("#fff3cd")}>
          ⚠️ <b>code fingerprint changed — blocked.</b>
          <p>
            pinned: <code>{fp(state.result.pinConflict!.pinned)}</code>
            <br />
            current: <code>{fp(state.result.pinConflict!.current)}</code>
          </p>
          <p style={{ fontSize: 13 }}>
            Check the release ({state.result.releaseTag} · digest{" "}
            {fp(state.result.releaseDigest)}) before approving.
          </p>
          <button onClick={() => { repin(state.result); void run(); }}>
            I reviewed it — approve new fingerprint
          </button>
        </div>
      )}

      {state.phase === "attested" && (
        <>
          <p style={box("#e8f5e9")}>
            {DEV ? "🛠 DEV — no attestation (local parity)" : `✅ attested · ${state.result.releaseTag} · pinned`}{" "}
            {state.result.firstPin ? "(first connect — TOFU)" : "(match)"}
          </p>
          {state.locked ? (
            <div style={box("#eef")}>
              🔐 <b>locked</b> — this enclave holds no key to your data.
              <p style={{ fontSize: 13 }}>
                Unlocking generates a 64-byte secret on this device, delivers it through the
                attested channel, and derives every server-side key from it.
              </p>
              <p style={{ fontSize: 13 }}>
                <label>
                  inference key (Tinfoil, memory-only):{" "}
                  <input
                    type="password"
                    value={keyInput}
                    onChange={(e) => setKeyInput(e.target.value)}
                    placeholder="tk_…"
                    style={{ width: 240 }}
                  />
                </label>
              </p>
              <button onClick={() => void doUnlock(state.result)}>
                {getToken() ? "unlock with stored secret" : "generate secret & unlock"}
              </button>
            </div>
          ) : (
            <button onClick={() => void doUnlock(state.result)}>resume session</button>
          )}
        </>
      )}

      {state.phase === "unlocking" && <p style={box("#eee")}>🔑 unlocking…</p>}

      {state.phase === "asleep" && (
        <div style={box("#eef")}>
          😴 <b>waddle is asleep</b> — the instance is stopped; billing stopped with it.
          {state.note && <p style={{ fontSize: 13 }}>{state.note}</p>}
          <button disabled={state.waking} onClick={() => void wake()}>
            {state.waking ? "waking…" : "☀️ wake waddle"}
          </button>
        </div>
      )}

      {state.phase === "chat" && (
        <>
          <p style={box("#e8f5e9")}>
            {DEV ? "🛠 DEV — unlocked (local parity)" : `✅ attested · ${state.result.releaseTag} · unlocked`} ·{" "}
            {state.connected ? "stream live" : "⚠️ disconnected — reload to re-replay"}
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", minHeight: 200 }}>
            {state.messages.map((m, i) => (
              <div
                key={i}
                style={{
                  alignSelf: m.role === "user" ? "flex-end" : "flex-start",
                  background: m.role === "user" ? "#dcedf8" : "#f1f1f1",
                  borderRadius: 10,
                  padding: "0.5rem 0.8rem",
                  maxWidth: "80%",
                  whiteSpace: "pre-wrap",
                }}
              >
                {m.text}
              </div>
            ))}
            {state.streaming && (
              <div
                style={{
                  alignSelf: "flex-start",
                  background: "#f9f9f9",
                  borderRadius: 10,
                  padding: "0.5rem 0.8rem",
                  maxWidth: "80%",
                  whiteSpace: "pre-wrap",
                  opacity: 0.85,
                }}
              >
                {state.streaming}
                <span className="cursor">▍</span>
              </div>
            )}
          </div>
          {state.error && <p style={box("#fde8e8")}>⛔ {state.error}</p>}
          <button
            style={{ marginTop: "0.5rem" }}
            onClick={() => connRef.current?.send({ type: "sleep_now" } as never)}
          >
            💤 put waddle to sleep
          </button>
          <div style={{ display: "flex", gap: "0.5rem", marginTop: "1rem" }}>
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && send()}
              placeholder="talk to your agent…"
              style={{ flex: 1, padding: "0.5rem 0.8rem" }}
            />
            <button onClick={send}>send</button>
          </div>
        </>
      )}

      <p style={{ fontSize: 12, color: "#999", marginTop: "2rem" }}>
        enclave {ENCLAVE_URL}
      </p>
    </main>
  );
}
