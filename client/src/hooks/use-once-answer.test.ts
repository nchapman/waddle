import { test } from "node:test";
import assert from "node:assert/strict";
import { answerFromKey } from "./use-once-answer.js";

test("⏎ answers yes, esc answers no", () => {
  assert.equal(answerFromKey({ key: "Enter", target: null }), true);
  assert.equal(answerFromKey({ key: "Escape", target: null }), false);
});

test("any other key is not an answer", () => {
  assert.equal(answerFromKey({ key: "a", target: null }), null);
  assert.equal(answerFromKey({ key: "Tab", target: null }), null);
});

test("keystrokes while typing in an input/textarea never answer the dialog", () => {
  // Enter inside the unlock form's key input must not approve a tool call.
  assert.equal(answerFromKey({ key: "Enter", target: { tagName: "INPUT" } }), null);
  assert.equal(answerFromKey({ key: "Escape", target: { tagName: "TEXTAREA" } }), null);
});
