import { useCallback, useEffect, useState } from "react";
import { verifyEnclave, repin, type AttestationResult } from "./lib/attestation";

const ENCLAVE_URL =
  import.meta.env.VITE_ENCLAVE_URL ?? "https://waddle.ddg-waddle.containers.tinfoil.dev";
const CONFIG_REPO = import.meta.env.VITE_CONFIG_REPO ?? "nchapman/waddle-config";

type State =
  | { phase: "verifying" }
  | { phase: "error"; message: string }
  | { phase: "blocked"; result: AttestationResult }
  | { phase: "verified"; result: AttestationResult; health: string };

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
      // Prove the verified-request path: fetch /health through the pinned client.
      const res = await result.client.fetch(`${ENCLAVE_URL}/health`);
      const body = (await res.json()) as { service: string; version: string; locked: boolean };
      setState({ phase: "verified", result, health: `${body.service} v${body.version} · ${body.locked ? "locked" : "unlocked"}` });
    } catch (e) {
      setState({ phase: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  useEffect(() => {
    void run();
  }, [run]);

  return (
    <main style={{ fontFamily: "system-ui", padding: "2rem", maxWidth: 720 }}>
      <h1>waddle</h1>

      {state.phase === "verifying" && <p style={box("#eee")}>🔒 verifying enclave…</p>}

      {state.phase === "error" && (
        <p style={box("#fde8e8")}>
          ⛔ attestation failed — <b>no secrets will move</b>: {state.message}
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

      {state.phase === "verified" && (
        <>
          <p style={box("#e8f5e9")}>
            ✅ attested · {state.result.releaseTag} · pinned{" "}
            {state.result.firstPin ? "(first connect — TOFU)" : "(match)"} ·{" "}
            {state.health}
          </p>
          <p style={{ fontSize: 13, color: "#666" }}>
            code <code>{fp(state.result.codeFingerprint)}</code> · repo{" "}
            <code>{state.result.configRepo}</code> · steps{" "}
            {Object.keys(state.result.steps).join(" ✓ ")} ✓
          </p>
        </>
      )}

      <p style={{ fontSize: 12, color: "#999", marginTop: "2rem" }}>
        enclave {ENCLAVE_URL}
      </p>
    </main>
  );
}
