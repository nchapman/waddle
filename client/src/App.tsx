import { useCallback, useEffect, useRef, useState } from "react";
import { verifyEnclave, repin, type AttestationResult } from "./lib/attestation";
import { unlock, getState, forgetSecret, getToken, getInferenceKey, setInferenceKey } from "./lib/session";
import { connectChat, type ServerEvent, type ChatConnection } from "./lib/ws";
import type { StateResponse } from "@waddle/sdk";

const ENCLAVE_URL =
  import.meta.env.VITE_ENCLAVE_URL ?? "https://waddle.ddg-waddle.containers.tinfoil.dev";
const CONFIG_REPO = import.meta.env.VITE_CONFIG_REPO ?? "nchapman/waddle-config";

interface ChatMessage {
  role: "user" | "assistant";
  text: string;
}

type State =
  | { phase: "verifying" }
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

export function App() {
  const [state, setState] = useState<State>({ phase: "verifying" });
  const [keyInput, setKeyInput] = useState(getInferenceKey());
  const connRef = useRef<ChatConnection | null>(null);
  const [draft, setDraft] = useState("");

  const run = useCallback(async () => {
    setState({ phase: "verifying" });
    try {
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
        return {
          ...s,
          streaming: event.role === "assistant" ? "" : s.streaming,
          messages: [...s.messages, { role: event.role, text: event.text }],
          error: undefined,
        };
      }
      if (event.type === "delta") return { ...s, streaming: s.streaming + event.text };
      if (event.type === "error") return { ...s, error: event.message };
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
        setState({ phase: "chat", result, messages: [], streaming: "", connected: true });
      } catch (e) {
        setState({ phase: "error", message: `unlock: ${e instanceof Error ? e.message : String(e)}` });
      }
    },
    [keyInput, onServerEvent],
  );

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
          <button onClick={() => { forgetSecret(); void run(); }}>forget secret & retry</button>
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
            ✅ attested · {state.result.releaseTag} · pinned{" "}
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

      {state.phase === "chat" && (
        <>
          <p style={box("#e8f5e9")}>
            ✅ attested · {state.result.releaseTag} · unlocked ·{" "}
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
