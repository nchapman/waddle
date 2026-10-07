import { useEffect, useState } from "react";
import type { HelloResponse } from "@waddle/sdk";

/**
 * Scaffold App — proves the client ↔ VM path (health over the Vite proxy).
 * Phase 1 replaces this with the real client: assistant-ui over an AI SDK
 * ChatTransport bridged to the gateway WSS, attestation badge, lock screen.
 */
export function App() {
  const [status, setStatus] = useState<HelloResponse | "connecting" | "down">("connecting");

  useEffect(() => {
    const poll = () =>
      fetch("/health")
        .then((r) => r.json() as Promise<HelloResponse>)
        .then(setStatus)
        .catch(() => setStatus("down"));
    poll();
    const t = setInterval(poll, 3000);
    return () => clearInterval(t);
  }, []);

  return (
    <main style={{ fontFamily: "system-ui", padding: "2rem" }}>
      <h1>waddle</h1>
      <p>
        VM:{" "}
        {status === "connecting" || status === "down" ? (
          <span style={{ color: status === "down" ? "#c00" : "#888" }}>{status}</span>
        ) : (
          <span style={{ color: "#070" }}>
            up · v{status.version} · {status.locked ? "locked" : "unlocked"}
          </span>
        )}
      </p>
    </main>
  );
}
