import { useCallback, useEffect, useState } from "react";
import { verifyEnclave, repin, type AttestationResult } from "./lib/attestation";
import { unlock, getState, forgetSecret, getToken } from "./lib/session";
import type { StateResponse } from "@waddle/sdk";

const ENCLAVE_URL =
  import.meta.env.VITE_ENCLAVE_URL ?? "https://waddle.ddg-waddle.containers.tinfoil.dev";
const CONFIG_REPO = import.meta.env.VITE_CONFIG_REPO ?? "nchapman/waddle-config";

type State =
  | { phase: "verifying" }
  | { phase: "error"; message: string }
  | { phase: "blocked"; result: AttestationResult }
  | { phase: "attested"; result: AttestationResult; locked: boolean }
  | { phase: "unlocking" }
  | { phase: "unlocked"; result: AttestationResult; state: StateResponse };

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
  }, [run]);

  const doUnlock = useCallback(async (result: AttestationResult) => {
    setState({ phase: "unlocking" });
    try {
      await unlock(result.client, ENCLAVE_URL);
      const s = await getState(result.client, ENCLAVE_URL);
      setState({ phase: "unlocked", result, state: s });
    } catch (e) {
      setState({ phase: "error", message: `unlock: ${e instanceof Error ? e.message : String(e)}` });
    }
  }, []);

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
                attested channel, and derives every server-side key from it. It never leaves
                except through that channel.
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

      {state.phase === "unlocked" && (
        <>
          <p style={box("#e8f5e9")}>
            ✅ attested · {state.result.releaseTag} · <b>unlocked</b>
            {state.state.enrolled ? " (enrolled)" : ""}
          </p>
          <p style={{ fontSize: 13, color: "#666" }}>
            code <code>{fp(state.result.codeFingerprint)}</code> · session sees{" "}
            {state.state.events.length} events
          </p>
          <ul style={{ fontSize: 13 }}>
            {state.state.events.slice(-5).map((e, i) => (
              <li key={i}>
                <code>{JSON.stringify(e).slice(0, 90)}</code>
              </li>
            ))}
          </ul>
        </>
      )}

      <p style={{ fontSize: 12, color: "#999", marginTop: "2rem" }}>
        enclave {ENCLAVE_URL}
      </p>
    </main>
  );
}
