/**
 * The pure timing/tab helpers behind the browser tools — no Chromium
 * needed: waitUntil's deadline behavior, the new-tab picker's seen-set
 * semantics, and the wait-probe expression builder's escaping.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickNewPage, buildWaitProbe, waitUntil } from "./browser.js";

test("waitUntil: resolves true on the first passing check", async () => {
  let calls = 0;
  const ok = await waitUntil(
    () => {
      calls++;
      return calls >= 2;
    },
    { intervalMs: 5, timeoutMs: 1_000 },
  );
  assert.equal(ok, true);
  assert.equal(calls, 2);
});

test("waitUntil: resolves false at the deadline (interval lapses honored)", async () => {
  const ok = await waitUntil(() => false, { intervalMs: 5, timeoutMs: 20 });
  assert.equal(ok, false);
});

test("waitUntil: a throwing check reads as not-yet (mid-navigation shape)", async () => {
  let threw = true;
  const ok = await waitUntil(
    () => {
      if (threw) {
        threw = false;
        throw new Error("Execution context was destroyed");
      }
      return true;
    },
    { intervalMs: 5, timeoutMs: 1_000 },
  );
  assert.equal(ok, true);
});

test("pickNewPage: the unseen page wins, newest first", () => {
  const seen = new Set(["p1"]);
  assert.equal(pickNewPage(seen, [{ id: "p1" }, { id: "p2" }], "p1"), "p2");
  // Newest of several fresh tabs (chronological list, last = newest).
  assert.equal(pickNewPage(seen, [{ id: "p1" }, { id: "p2" }, { id: "p3" }], "p1"), "p3");
});

test("pickNewPage: nothing fresh, or only the current page — no switch", () => {
  const seen = new Set(["p1", "p2"]);
  assert.equal(pickNewPage(seen, [{ id: "p1" }, { id: "p2" }], "p1"), null);
  // The current page is excluded even if unregistered (never "new").
  assert.equal(pickNewPage(new Set(), [{ id: "p1" }], "p1"), null);
  assert.equal(pickNewPage(new Set(), [], "p1"), null);
});

test("buildWaitProbe: appears / gone / both, evaluated as behavior — and a hostile needle stays a literal", () => {
  const evalProbe = (probe: string, text: string): boolean =>
    (new Function("document", "return " + probe) as (d: unknown) => boolean)({ body: { innerText: text } });
  // Appears.
  assert.equal(evalProbe(buildWaitProbe("Results", ""), "no results yet"), false);
  assert.equal(evalProbe(buildWaitProbe("Results", ""), "10 Results found"), true);
  // Gone.
  assert.equal(evalProbe(buildWaitProbe("", "Loading…"), "Ready"), true);
  assert.equal(evalProbe(buildWaitProbe("", "Loading…"), "Loading…"), false);
  // Both at once.
  assert.equal(evalProbe(buildWaitProbe("a", "b"), "has a"), true);
  assert.equal(evalProbe(buildWaitProbe("a", "b"), "has a and b"), false);
  // A needle crafted to close the string literal must be matched as
  // literal TEXT (found when present, not found when absent) — a
  // quoting break either fails to parse or flips one of these. The
  // JSON.stringify containment is the structural guarantee the behavior
  // assertions can't see: the needle rides ONLY inside a quoted literal.
  const needle = '") || true || t.includes("';
  const hostile = buildWaitProbe(needle, "");
  assert.ok(hostile.includes(JSON.stringify(needle)), "the needle rides as a JSON string literal, never raw");
  assert.equal(evalProbe(hostile, "plain text"), false, "absent needle: not found");
  assert.equal(evalProbe(hostile, `page says ${needle} hi`), true, "present needle: found as literal text, not executed");
});
