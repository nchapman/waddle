/**
 * The Hands: user input over the enclave's live frame. The wrapper maps
 * pointer/keys to normalized events (letterbox-corrected against the img's
 * real content rect), batches them, and ships browser_input intents — which
 * are transient by contract (never sealed; the enclave maps them to CDP).
 *
 * Esc hands control back (or closes the overlay — the parent decides via
 * onEscapeBeforeClose). The page inside the enclave has no cursor of its
 * own, so we draw one locally: zero-latency feedback, the frames follow.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { UserIntent } from "@waddle/sdk";

/** The wire shape — taken from the sdk so client and gateway can't drift. */
export type InputEvent = Extract<UserIntent, { type: "browser_input" }>["events"][number];

const KEY_SEND = new Set([
  "Enter", "Tab", "Backspace", "Delete", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
  "Home", "End", "PageUp", "PageDown", "Shift", "Control", "Alt", "Meta",
]);

export function InteractFrame({
  frame,
  held,
  onRelease,
  send,
  children,
  className,
}: {
  frame: string | null;
  held: boolean;
  onRelease: () => void;
  send: (intent: { type: "browser_input"; events: InputEvent[] } | { type: "browser_release" }) => void;
  children: React.ReactNode;
  className?: string;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const queue = useRef<InputEvent[]>([]);
  const lastMove = useRef(0);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [focused, setFocused] = useState(false);

  // Flush loop: coalesce bursts into one intent every 30ms.
  useEffect(() => {
    const timer = setInterval(() => {
      if (queue.current.length === 0) return;
      const batch = queue.current.splice(0, 128);
      send({ type: "browser_input", events: batch });
    }, 30);
    return () => clearInterval(timer);
  }, [send]);

  /** Pointer → normalized [0..1] against the letterboxed content rect of
   *  the frame img inside this wrapper. */
  const norm = useCallback((clientX: number, clientY: number): { x: number; y: number } | null => {
    const img = boxRef.current?.querySelector("img");
    if (!(img instanceof HTMLImageElement) || !img.naturalWidth) return null;
    const r = img.getBoundingClientRect();
    const scale = Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight);
    const w = img.naturalWidth * scale;
    const h = img.naturalHeight * scale;
    const ox = r.left + (r.width - w) / 2;
    const oy = r.top + (r.height - h) / 2;
    return {
      x: Math.min(1, Math.max(0, (clientX - ox) / w)),
      y: Math.min(1, Math.max(0, (clientY - oy) / h)),
    };
  }, []);

  const local = (e: React.PointerEvent): { x: number; y: number } | null => {
    const box = boxRef.current?.getBoundingClientRect();
    if (box) setCursor({ x: e.clientX - box.left, y: e.clientY - box.top });
    return norm(e.clientX, e.clientY);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    local(e);
    if (!held) return; // passive viewer: moves never seize the wheel — only a click does
    const now = performance.now();
    if (now - lastMove.current < 40) return; // ~25 moves/s is plenty for hover
    lastMove.current = now;
    const p = norm(e.clientX, e.clientY);
    if (p) queue.current.push({ t: "move", x: p.x, y: p.y });
  };

  const button = (b: number): "left" | "right" | "middle" | null =>
    b === 0 ? "left" : b === 1 ? "middle" : b === 2 ? "right" : null;

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    boxRef.current?.focus();
    const p = local(e);
    const b = button(e.button);
    if (p && b) queue.current.push({ t: "down", x: p.x, y: p.y, b });
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const p = norm(e.clientX, e.clientY);
    const b = button(e.button);
    if (p && b) queue.current.push({ t: "up", x: p.x, y: p.y, b });
  };

  const onWheel = (e: React.WheelEvent) => {
    if (!held) return; // wheel on the passive view scrolls nothing in the enclave
    e.preventDefault();
    const p = norm(e.clientX, e.clientY);
    queue.current.push({ t: "wheel", dx: e.deltaX, dy: e.deltaY, x: p?.x, y: p?.y });
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      // Esc both hands back AND forwards as a key event: when a native
      // dialog is open the server consumes it (dismiss), and the wheel
      // drops either way — no modal traps the user.
      queue.current.push({ t: "key", k: "Escape" });
      if (held) onRelease();
      return;
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      queue.current.push({ t: "text", s: e.key });
      return;
    }
    if (KEY_SEND.has(e.key)) {
      e.preventDefault();
      queue.current.push({ t: "key", k: e.key, up: e.type === "keyup" });
    }
  };

  return (
    <div
      ref={boxRef}
      tabIndex={0}
      role="application"
      aria-label="interactive enclave browser view"
      onPointerMove={onPointerMove}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onWheel={onWheel}
      onKeyDown={onKey}
      onKeyUp={onKey}
      onPointerLeave={() => setCursor(null)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      className={className}
      style={{ position: "relative", outline: "none", cursor: "none", touchAction: "none" }}
    >
      {children}
      {(held || focused) && cursor && (
        <svg
          aria-hidden
          viewBox="0 0 24 24"
          style={{
            position: "absolute",
            left: cursor.x,
            top: cursor.y,
            width: 18,
            height: 18,
            pointerEvents: "none",
            filter: "drop-shadow(0 1px 2px rgba(0,0,0,.8))",
            transform: "translate(-1px, -1px)",
          }}
        >
          <path d="M4 2l14 8-6 1.5L9 19z" fill={held ? "#f7b32b" : "#ffffff"} stroke="#1c1917" strokeWidth="1.2" />
        </svg>
      )}
    </div>
  );
}
