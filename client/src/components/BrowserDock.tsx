/**
 * The Eyes, docked: the live enclave viewport as a right-hand panel in the
 * shell. Dark chrome around the stream; LIVE pulse + fps + URL bar; expand
 * opens the large overlay (esc collapses). Pure display — the enclave is
 * the only place pages render.
 */
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { InteractFrame, type InputEvent } from "./InteractFrame";

type Send = (intent: { type: "browser_input"; events: InputEvent[] } | { type: "browser_release" }) => void;

function prettyUrl(u?: string): string {
  if (!u) return "about:blank";
  try {
    const parsed = new URL(u);
    return `${parsed.hostname}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return u.slice(0, 60);
  }
}

export function BrowserDock({
  frame,
  url,
  title,
  onExpand,
  held,
  onRelease,
  send,
}: {
  frame: string | null;
  url?: string;
  title?: string;
  onExpand: () => void;
  held: boolean;
  onRelease: () => void;
  send: Send;
}) {
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

  if (!frame) return null;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-border/70 bg-card shadow-xl shadow-black/30">
      <div className="flex items-center gap-2.5 border-b border-border/60 bg-secondary/60 px-3.5 py-2.5">
        <span className="waddle-live-dot h-2 w-2 shrink-0 rounded-full bg-live" />
        <div className="min-w-0 flex-1" title={title || url}>
          <div className="truncate text-xs font-medium text-foreground/90">{prettyUrl(url)}</div>
          {title && <div className="truncate text-[10px] text-muted-foreground">{title}</div>}
        </div>
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
          {fps > 0 ? `${fps}fps` : "live"}
        </span>
        {held && (
          <button
            onClick={onRelease}
            className="shrink-0 rounded-lg border border-duck/60 bg-duck/10 px-2 py-1 text-[10px] font-medium text-duck"
            title="hand the browser back to waddle (esc)"
          >
            you have the mouse — hand back
          </button>
        )}
        <button
          onClick={onExpand}
          className="shrink-0 rounded-lg border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:border-duck/50 hover:text-duck"
          title="expand"
        >
          ⤢
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden bg-black/40">
        <InteractFrame frame={frame} held={held} onRelease={onRelease} send={send} className={cn("h-full w-full", held && "ring-1 ring-inset ring-duck/50")}>
          <img
            src={frame}
            alt="waddle's browser (live — click to interact)"
            className="h-full w-full object-contain object-top"
          />
        </InteractFrame>
      </div>
    </div>
  );
}

export function BrowserOverlay({
  frame,
  url,
  title,
  onClose,
  held,
  onRelease,
  send,
}: {
  frame: string | null;
  url?: string;
  title?: string;
  onClose: () => void;
  held: boolean;
  onRelease: () => void;
  send: Send;
}) {
  useEffect(() => {
    if (!frame) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // While holding the mouse, esc hands back first; the next esc closes.
      if (held) onRelease();
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [frame, onClose, held, onRelease]);

  if (!frame) return null;
  return (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-[3vh_3vw] backdrop-blur-sm"
    >
      <div className="flex max-h-full w-[min(1400px,94vw)] flex-col overflow-hidden rounded-2xl border border-border/60 bg-card shadow-2xl shadow-black/60">
        <div className="flex items-center gap-2.5 border-b border-border/60 bg-secondary/60 px-4 py-3">
          <span className="waddle-live-dot h-2 w-2 shrink-0 rounded-full bg-live" />
          <div className="min-w-0 flex-1" title={title || url}>
            <div className="truncate text-sm font-medium">{prettyUrl(url)}</div>
            {title && <div className="truncate text-xs text-muted-foreground">{title}</div>}
          </div>
          <button
            onClick={onClose}
            className="shrink-0 rounded-lg border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-duck/50 hover:text-duck"
          >
            esc ⤡
          </button>
        </div>
        <InteractFrame frame={frame} held={held} onRelease={onRelease} send={send} className={cn("w-full max-h-[84vh]", held && "ring-1 ring-inset ring-duck/50")}>
          <img
            src={frame}
            alt="waddle's browser (live, expanded — click to interact)"
            className="max-h-[84vh] w-full object-contain"
          />
        </InteractFrame>
      </div>
    </div>
  );
}
