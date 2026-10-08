/**
 * The Eyes (client): live viewport of the enclave's Chromium.
 *
 * Frames arrive as jpeg data-URLs over the attested ws (~10fps). The card
 * is a small preview beside the conversation; expand opens a large overlay
 * (ESC or the button to collapse). Pure display — no client-side browser
 * state, the enclave is the only place pages render.
 */
import { useEffect, useRef, useState } from "react";

interface BrowserPreviewProps {
  frame: string | null;
  url?: string;
  title?: string;
}

function prettyUrl(u?: string): string {
  if (!u) return "about:blank";
  try {
    const parsed = new URL(u);
    return `${parsed.hostname}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return u.slice(0, 60);
  }
}

export function BrowserPreview({ frame, url, title }: BrowserPreviewProps) {
  const [expanded, setExpanded] = useState(false);
  const [fps, setFps] = useState(0);
  const frames = useRef(0);
  const lastTick = useRef(Date.now());

  useEffect(() => {
    if (!frame) return;
    frames.current += 1;
    const now = Date.now();
    if (now - lastTick.current >= 1000) {
      setFps(Math.round((frames.current * 1000) / (now - lastTick.current)));
      frames.current = 0;
      lastTick.current = now;
    }
  }, [frame]);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  if (!frame) return null;

  const header = (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 10px",
        background: "linear-gradient(180deg, #f8fafc, #eef2f7)",
        borderBottom: "1px solid #e2e8f0",
        fontSize: 12,
        color: "#334155",
      }}
    >
      <span
        aria-label="live"
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: "#22c55e",
          boxShadow: "0 0 0 0 rgba(34,197,94,0.6)",
          animation: "waddle-pulse 1.6s infinite",
          flexShrink: 0,
        }}
      />
      <span
        style={{
          fontFamily: "ui-monospace, monospace",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          flex: 1,
          textAlign: "left",
        }}
        title={title || url}
      >
        {prettyUrl(url)}
      </span>
      <span style={{ color: "#94a3b8", flexShrink: 0 }}>{fps > 0 ? `${fps}fps` : "live"}</span>
      <button
        onClick={() => setExpanded((v) => !v)}
        title={expanded ? "collapse (esc)" : "expand"}
        style={{
          border: "1px solid #cbd5e1",
          background: "#fff",
          borderRadius: 6,
          padding: "2px 8px",
          cursor: "pointer",
          fontSize: 12,
          flexShrink: 0,
        }}
      >
        {expanded ? "⤡ collapse" : "⤢ expand"}
      </button>
    </div>
  );

  const image = (
    <img
      src={frame}
      alt="waddle's browser (live)"
      style={{
        display: "block",
        width: "100%",
        maxHeight: expanded ? "84vh" : 320,
        objectFit: "contain",
        background: "#fff",
        imageRendering: "auto",
      }}
    />
  );

  if (expanded) {
    return (
      <div
        onClick={(e) => {
          if (e.target === e.currentTarget) setExpanded(false);
        }}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 1000,
          background: "rgba(15, 23, 42, 0.72)",
          backdropFilter: "blur(4px)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "3vh 3vw",
        }}
      >
        <div
          style={{
            width: "min(1400px, 94vw)",
            background: "#fff",
            borderRadius: 14,
            overflow: "hidden",
            boxShadow: "0 24px 80px rgba(0,0,0,0.45)",
            display: "flex",
            flexDirection: "column",
          }}
        >
          {header}
          {image}
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        background: "#fff",
        borderRadius: 12,
        overflow: "hidden",
        border: "1px solid #e2e8f0",
        boxShadow: "0 4px 18px rgba(15,23,42,0.08)",
        marginBottom: "0.75rem",
      }}
    >
      {header}
      {image}
    </div>
  );
}
