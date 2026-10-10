/**
 * User browser input: client events (normalized coordinates, DOM key names)
 * translated to CDP Input-domain messages. Pure and unit-tested — the wire
 * format is tiny on purpose: nothing here ever carries more than one
 * keystroke batch, and these events are NEVER sealed into the log (the log
 * must not become a password recorder; only control transitions are).
 *
 * Coordinates: the client sends [0..1] against the frame it sees; the server
 * maps to viewport CSS pixels using the REAL layout metrics (not a configured
 * viewport — the classic off-target-click trap is trusting the configured
 * size when the content area differs).
 *
 * Keys: printable characters ride keyDown-with-text (+ keyUp) so pages see
 * real key events — bank logins and captcha widgets listen for them;
 * insertText-only skips keydown/keyup. Control keys come from the table
 * with their Windows virtual key codes.
 */

import type { BrowserInputEvent } from "@waddle/sdk";

export type UserInputEvent = BrowserInputEvent;

export interface CdpInputMessage {
  method: "Input.dispatchMouseEvent" | "Input.dispatchKeyEvent" | "Input.insertText";
  params: Record<string, unknown>;
}

/** DOM key name → { code, vk } (Windows virtual key code). */
const KEY_TABLE: Record<string, { code: string; vk: number; mod?: number }> = {
  Enter: { code: "Enter", vk: 13 },
  Tab: { code: "Tab", vk: 9 },
  Backspace: { code: "Backspace", vk: 8 },
  Delete: { code: "Delete", vk: 46 },
  ArrowLeft: { code: "ArrowLeft", vk: 37 },
  ArrowRight: { code: "ArrowRight", vk: 39 },
  ArrowUp: { code: "ArrowUp", vk: 38 },
  ArrowDown: { code: "ArrowDown", vk: 40 },
  Home: { code: "Home", vk: 36 },
  End: { code: "End", vk: 35 },
  PageUp: { code: "PageUp", vk: 33 },
  PageDown: { code: "PageDown", vk: 34 },
  Shift: { code: "ShiftLeft", vk: 16, mod: 8 },
  Control: { code: "ControlLeft", vk: 17, mod: 2 },
  Alt: { code: "AltLeft", vk: 18, mod: 1 },
  Meta: { code: "MetaLeft", vk: 91, mod: 4 },
};

const MODS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 } as const;

/** Translate a batch of user events to CDP messages against a viewport of
 *  `w` x `h` CSS pixels. Modifier state tracks across the batch. */
export function toCdp(events: UserInputEvent[], viewport: { w: number; h: number }): CdpInputMessage[] {
  const out: CdpInputMessage[] = [];
  let modifiers = 0;
  const px = (x: number) => Math.max(0, Math.min(viewport.w, Math.round(x * viewport.w)));
  const py = (y: number) => Math.max(0, Math.min(viewport.h, Math.round(y * viewport.h)));

  for (const ev of events) {
    switch (ev.t) {
      case "move":
        out.push({ method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", x: px(ev.x), y: py(ev.y), modifiers } });
        break;
      case "down":
      case "up": {
        const button = ev.b ?? "left";
        out.push({
          method: "Input.dispatchMouseEvent",
          params: {
            type: ev.t === "down" ? "mousePressed" : "mouseReleased",
            x: px(ev.x),
            y: py(ev.y),
            button,
            buttons: ev.t === "down" ? (button === "left" ? 1 : button === "right" ? 2 : 4) : 0,
            clickCount: 1,
            modifiers,
          },
        });
        break;
      }
      case "wheel":
        out.push({
          method: "Input.dispatchMouseEvent",
          params: {
            type: "mouseWheel",
            x: px(ev.x ?? 0.5),
            y: py(ev.y ?? 0.5),
            deltaX: Math.round(ev.dx),
            deltaY: Math.round(ev.dy),
            modifiers,
          },
        });
        break;
      case "text": {
        // Printable run: each char as a real key event (keyDown with text,
        // then keyUp) — pages that listen for keydown see them.
        for (const ch of ev.s.slice(0, 64)) {
          out.push({
            method: "Input.dispatchKeyEvent",
            params: { type: "keyDown", key: ch, text: ch, modifiers, windowsVirtualKeyCode: ch === " " ? 32 : 0 },
          });
          out.push({ method: "Input.dispatchKeyEvent", params: { type: "keyUp", key: ch, modifiers } });
        }
        break;
      }
      case "key": {
        const k = KEY_TABLE[ev.k];
        if (!k) break; // unknown key: dropped (v1 table is the contract)
        if (k.mod) {
          // Held-while-down: the client sends press (up=false) and release
          // (up=true) separately; the bitmask stays set between them so
          // every event in the batch carries truthful modifiers.
          modifiers = ev.up ? (modifiers & ~k.mod) >>> 0 : (modifiers | k.mod) >>> 0;
          out.push({
            method: "Input.dispatchKeyEvent",
            params: { type: ev.up ? "keyUp" : "keyDown", key: ev.k, code: k.code, windowsVirtualKeyCode: k.vk, modifiers },
          });
        } else {
          const text = ev.k === "Enter" ? "\r" : undefined;
          out.push({
            method: "Input.dispatchKeyEvent",
            params: { type: ev.up ? "keyUp" : "keyDown", key: ev.k, code: k.code, windowsVirtualKeyCode: k.vk, text: ev.up ? undefined : text, modifiers },
          });
        }
        break;
      }
    }
  }
  return out;
}
