import { test } from "node:test";
import assert from "node:assert/strict";
import { toCdp, type UserInputEvent } from "./input-map.js";

const vp = { w: 1000, h: 500 };

test("normalized pointer coordinates map to viewport CSS pixels (clamped)", () => {
  const m = toCdp([{ t: "move", x: 0.5, y: 0.25 }], vp)[0]!;
  assert.equal(m.method, "Input.dispatchMouseEvent");
  assert.equal(m.params.type, "mouseMoved");
  assert.equal(m.params.x, 500);
  assert.equal(m.params.y, 125);
  const c = toCdp([{ t: "down", x: 1.4, y: -0.2 }], vp)[0]!; // out of range: clamp
  assert.equal(c.params.x, 1000);
  assert.equal(c.params.y, 0);
});

test("down/up become mousePressed/mouseReleased with button state", () => {
  const d = toCdp([{ t: "down", x: 0.1, y: 0.1 }], vp)[0]!;
  const u = toCdp([{ t: "up", x: 0.1, y: 0.1 }], vp)[0]!;
  assert.equal(d.params.type, "mousePressed");
  assert.equal(d.params.button, "left");
  assert.equal(d.params.buttons, 1);
  assert.equal(u.params.type, "mouseReleased");
  assert.equal(u.params.buttons, 0);
});

test("printable text rides keyDown-with-text then keyUp (real key events)", () => {
  const msgs = toCdp([{ t: "text", s: "hi" }], vp);
  assert.equal(msgs.length, 4);
  const d1 = msgs[0]!;
  const u1 = msgs[1]!;
  const d2 = msgs[2]!;
  assert.equal(d1.method, "Input.dispatchKeyEvent");
  assert.equal(d1.params.type, "keyDown");
  assert.equal(d1.params.key, "h");
  assert.equal(d1.params.text, "h");
  assert.equal(u1.params.type, "keyUp");
  assert.equal(d2.params.key, "i");
});

test("control keys carry code + windows virtual key; Enter maps CR text", () => {
  const d = toCdp([{ t: "key", k: "Enter" }], vp)[0]!;
  assert.equal(d.params.windowsVirtualKeyCode, 13);
  assert.equal(d.params.text, "\r");
  const u = toCdp([{ t: "key", k: "Enter", up: true }], vp)[0]!;
  assert.equal(u.params.type, "keyUp");
  assert.equal(u.params.text, undefined);
  const b = toCdp([{ t: "key", k: "Backspace" }], vp)[0]!;
  assert.equal(b.params.windowsVirtualKeyCode, 8);
  assert.equal(b.params.text, undefined);
});

test("modifiers track press→hold→release across the batch", () => {
  const msgs = toCdp(
    [
      { t: "key", k: "Shift" },
      { t: "text", s: "a" },
      { t: "key", k: "Shift", up: true },
      { t: "text", s: "a" },
    ] as UserInputEvent[],
    vp,
  );
  const shiftDown = msgs[0]!;
  assert.equal(shiftDown.params.modifiers, 8); // Shift bit set on its own keyDown
  const typed = msgs[1]!;
  assert.equal(typed.params.modifiers, 8); // carried while held
  const shiftUp = msgs[2]!;
  assert.equal(shiftUp.params.type, "keyUp");
  const after = msgs[3]!;
  assert.equal(after.params.modifiers, 0); // cleared on release
});

test("unknown keys are dropped; text batches are capped", () => {
  assert.deepEqual(toCdp([{ t: "key", k: "F13" }], vp), []);
  const msgs = toCdp([{ t: "text", s: "x".repeat(200) }], vp);
  assert.equal(msgs.length, 128); // 64 chars × (down + up)
});

test("wheel events map deltas with optional anchor", () => {
  const w = toCdp([{ t: "wheel", dx: 0, dy: 120 }], vp)[0]!;
  assert.equal(w.params.type, "mouseWheel");
  assert.equal(w.params.deltaY, 120);
  assert.equal(w.params.x, 500); // default anchor = viewport center
});
