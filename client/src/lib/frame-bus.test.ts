/**
 * Frame bus tests — screencast frames bypass React state by contract;
 * the bus is a newest-frame pub/sub. Invariants: subscribers see every
 * publish, a NEW subscriber immediately sees the newest frame (a
 * mounting dock isn't blank), unsubscribe stops delivery, and reset
 * clears the replay copy (sleep/fresh boot must not show a stale frame).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { frameBus } from "./frame-bus.js";

test("subscribers receive every published frame", () => {
  const seen: number[] = [];
  const off = frameBus.subscribe((f) => seen.push(f.seq));
  frameBus.publish({ data: "a", seq: 1 });
  frameBus.publish({ data: "b", seq: 2 });
  off();
  frameBus.publish({ data: "c", seq: 3 });
  assert.deepEqual(seen, [1, 2], "unsubscribed after off()");
});

test("a new subscriber immediately replays the newest frame (no blank dock)", () => {
  frameBus.reset();
  frameBus.publish({ data: "only", seq: 7 });
  let got: string | null = null;
  frameBus.subscribe((f) => (got = f.data));
  assert.equal(got, "only");
});

test("reset clears the replay copy — a fresh boot shows nothing stale", () => {
  frameBus.publish({ data: "stale", seq: 1 });
  frameBus.reset();
  let called = false;
  frameBus.subscribe(() => (called = true));
  assert.equal(called, false, "subscribe after reset must not deliver the dead frame");
});
