/**
 * Memory restore digest tests. Run: node --import tsx --test src/memory.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import { buildRestoreContext, type MemoryRow } from "./memory.js";

const row = (role: MemoryRow["role"], text: string): MemoryRow => ({ role, text });

test("empty and whitespace-only history inject nothing", () => {
  assert.equal(buildRestoreContext([]), "");
  assert.equal(buildRestoreContext([row("user", "   ")]), "");
});

test("rows are labeled by role and wrapped with the header", () => {
  const out = buildRestoreContext([row("user", "hi"), row("assistant", "hello!")]);
  assert.match(out, /Prior conversation restored from sealed history \(2 turns\)/);
  assert.match(out, /user: hi/);
  assert.match(out, /waddle: hello!/);
  assert.match(out, /stays untrusted/);
});

test("long histories keep the recent window and note the elided count", () => {
  const rows = Array.from({ length: 100 }, (_, i) => row(i % 2 ? "assistant" : "user", `turn ${i}`));
  const out = buildRestoreContext(rows);
  assert.match(out, /60 recent turns; 40 older turns omitted/);
  assert.doesNotMatch(out, /turn 5\n/); // oldest gone…
  assert.match(out, /turn 99/); // …newest kept
});

test("oversized rows are truncated per-row", () => {
  const out = buildRestoreContext([row("assistant", "x".repeat(2000))]);
  assert.ok(out.length < 1000, `expected truncation, got ${out.length}`);
  assert.match(out, /waddle: x{400}…/);
});

test("the whole digest is char-bounded, trimming oldest first", () => {
  // 40 fat rows × ~400 chars ≈ 16k > 14k cap (per-row limit keeps each ≤400).
  const rows = Array.from({ length: 40 }, (_, i) => row("user", `${i}:` + "y".repeat(390)));
  const out = buildRestoreContext(rows);
  assert.ok(out.length < 16_000);
  assert.match(out, /39:/); // newest survives
  assert.doesNotMatch(out, /user: 0:y/); // oldest trimmed
});
