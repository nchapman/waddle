import { test } from "node:test";
import assert from "node:assert/strict";

// Node 20+ has a localStorage global on the main context; fall back to a
// tiny shim so the preference module stays environment-agnostic.
if (typeof localStorage === "undefined") {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

const { getBackgroundPref, setBackgroundPref, hasAcceptedWarning, acceptWarning } = await import(
  "./background.js"
);

test("defaults to null — tier 0 is never silently assumed on a fresh device", () => {
  assert.equal(getBackgroundPref(), null);
  assert.equal(hasAcceptedWarning(), false);
});

test("setting on records the choice; the warning gate stays answerable", () => {
  setBackgroundPref(true);
  assert.equal(getBackgroundPref(), true);
  assert.equal(hasAcceptedWarning(), false, "choosing is not accepting — the modal decides");
  acceptWarning();
  assert.equal(hasAcceptedWarning(), true);
  assert.equal(getBackgroundPref(), true);
});

test("turning it off resets the acceptance (revocation = warn again)", () => {
  acceptWarning();
  setBackgroundPref(false);
  assert.equal(getBackgroundPref(), false);
  assert.equal(hasAcceptedWarning(), false, "re-enabling later re-warns");
});
