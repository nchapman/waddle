/**
 * WaddleChatTransport tests — the UIMessageChunk protocol is subtle
 * (learned the hard way): 'start' opens the message, a text part must be
 * opened before any text-delta, tool parts must not nest inside an open
 * text part, and run_settled/error close the stream. These pin the
 * ordering the assistant-ui runtime depends on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { UIMessage } from "@ai-sdk/react";
import type { UIMessageChunk } from "ai";
import type { UserIntent } from "@waddle/sdk";
import { WaddleChatTransport } from "./waddle-transport.js";

const msg = (text: string): UIMessage => ({
  id: "m1",
  role: "user",
  parts: [{ type: "text", text }],
});

/** Read every chunk the stream will ever emit (dispatches land first —
 *  the transport enqueues synchronously inside dispatch). */
async function drain(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const out: UIMessageChunk[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(value!);
  }
}

const shape = (chunks: UIMessageChunk[]): string[] =>
  chunks.map((c) => {
    const t = c.type as string;
    if (t === "text-delta") return "text-delta";
    return t;
  });

function harness(opts?: { idleFlushMs?: number; maxIdleRows?: number }) {
  const transport = new WaddleChatTransport(opts);
  const intents: UserIntent[] = [];
  transport.attach((i) => intents.push(i));
  return { transport, intents };
}

test("full turn: deltas open the text part first, tools close it, verdicts append, run_settled finishes", async () => {
  const { transport, intents } = harness();
  const stream = await transport.sendMessages({ trigger: "submit-message", messages: [msg("what time is it?")] });
  transport.dispatch({ type: "delta", messageId: "live", text: "It is " });
  transport.dispatch({ type: "delta", messageId: "live", text: "noon." });
  transport.dispatch({ type: "tool_start", callId: "t1", tool: "codemode", args: { code: "date" } });
  transport.dispatch({ type: "tool_end", callId: "t1", tool: "codemode", result: "12:00", isError: false });
  transport.dispatch({ type: "approval", callId: "t1", tool: "codemode", approved: true });
  transport.dispatch({ type: "run_settled" });
  const chunks = await drain(stream);

  assert.deepEqual(intents, [{ type: "user_message", text: "what time is it?" }]);
  assert.deepEqual(shape(chunks), [
    "start",
    "text-start", // opened BEFORE the first delta
    "text-delta",
    "text-delta",
    "text-end", // tool parts must not nest inside an open text part
    "tool-input-start",
    "tool-input-delta",
    "tool-output-available",
    "text-start", // verdict re-opens the part
    "text-delta",
    "text-end",
    "finish",
  ]);
  const finish = chunks.at(-1) as { type: string; finishReason?: string };
  assert.equal(finish.finishReason, "stop");
});

test("a failed tool renders tool-output-error, and an error event closes the turn with finishReason error", async () => {
  const { transport } = harness();
  const stream = await transport.sendMessages({ trigger: "submit-message", messages: [msg("x")] });
  transport.dispatch({ type: "tool_start", callId: "t1", tool: "codemode", args: {} });
  transport.dispatch({ type: "tool_end", callId: "t1", tool: "codemode", result: "boom", isError: true });
  transport.dispatch({ type: "error", message: "gateway exploded" });
  const chunks = await drain(stream);
  assert.deepEqual(shape(chunks), [
    "start",
    "tool-input-start",
    "tool-input-delta",
    "tool-output-error",
    "error",
    "finish",
  ]);
  const finish = chunks.at(-1) as { type: string; finishReason?: string };
  assert.equal(finish.finishReason, "error");
});

test("an empty/whitespace message produces an empty stream and sends nothing", async () => {
  const { transport, intents } = harness();
  const stream = await transport.sendMessages({ trigger: "submit-message", messages: [msg("   ")] });
  assert.deepEqual(await drain(stream), []);
  assert.deepEqual(intents, []);
});

test("detach mid-stream finishes the open turn — it can never hang", async () => {
  const { transport } = harness();
  const stream = await transport.sendMessages({ trigger: "submit-message", messages: [msg("x")] });
  transport.dispatch({ type: "delta", messageId: "live", text: "half" });
  transport.detach();
  const chunks = await drain(stream);
  assert.deepEqual(shape(chunks), ["start", "text-start", "text-delta", "text-end", "error", "finish"]);
});

test("non-chat events reach the app tap without an open stream (and dispatch with no tap is safe)", async () => {
  const { transport } = harness();
  const seen: string[] = [];
  transport.setAppTap((e) => seen.push(e.type));
  transport.dispatch({ type: "approval_request", callId: "c", tool: "codemode", input: {} });
  transport.dispatch({ type: "sleep", reason: "idle" }); // no active tap — must not throw
  assert.deepEqual(seen, ["approval_request", "sleep"]);
});

test("isStreaming gates server-appended rows: true while a local turn is open, false when idle", async () => {
  const { transport } = harness();
  // Idle: a scheduled fire's broadcast copy must append (renders the nudge).
  assert.equal(transport.isStreaming(), false);
  const stream = await transport.sendMessages({ trigger: "submit-message", messages: [msg("hi")] });
  // Open stream: the same broadcast would duplicate the local render.
  assert.equal(transport.isStreaming(), true);
  transport.dispatch({ type: "delta", messageId: "live", text: "hey" });
  transport.dispatch({ type: "run_settled" });
  await drain(stream);
  assert.equal(transport.isStreaming(), false, "settled clears the stream — later fires append again");
});

test("idle turns: a scheduled fire's rows collect and deliver whole; a streamed turn never delivers", async () => {
  const { transport } = harness();
  const delivered: Array<Array<{ role: string; text?: string }>> = [];
  transport.onServerRows = (rows) => delivered.push(rows.map((r) => ({ role: r.role, text: r.text })));

  // Idle: the fire's injected prompt opens the buffer, tools + final fill
  // it, and the final delivers the turn (settled is a backstop).
  transport.dispatch({ type: "message", id: "1", role: "user", text: "[scheduled: Call mom] nudge" });
  transport.dispatch({ type: "tool_start", callId: "c9", tool: "read", args: { path: "/x" } });
  transport.dispatch({ type: "tool_end", callId: "c9", tool: "read", result: "ok", isError: false });
  transport.dispatch({ type: "delta", messageId: "live", text: "ignored" });
  transport.dispatch({ type: "message", id: "2", role: "assistant", text: "ding ding" });
  transport.dispatch({ type: "run_settled" });
  assert.equal(delivered.length, 1, "one whole turn delivered");
  assert.deepEqual(
    delivered[0]!.map((r) => r.role),
    ["user", "tool", "tool", "assistant"],
    "the turn's rows arrive paired, deltas excluded",
  );
  assert.equal(delivered[0]![0]!.text, "[scheduled: Call mom] nudge");

  // A locally-submitted turn never delivers idle rows (the stream renders
  // the same broadcast events — a second copy would duplicate).
  const stream = await transport.sendMessages({ trigger: "submit-message", messages: [msg("hi")] });
  assert.equal(transport.isStreaming(), true);
  transport.dispatch({ type: "message", id: "3", role: "user", text: "hi" }); // own echo
  transport.dispatch({ type: "message", id: "4", role: "assistant", text: "hey" });
  transport.dispatch({ type: "run_settled" });
  await drain(stream);
  assert.equal(delivered.length, 1, "streamed turns deliver nothing");
});

test("a local submit supersedes a half-collected idle turn — no phantom rows at the stream's settle", async () => {
  const { transport } = harness();
  const delivered: Array<Array<{ role: string }>> = [];
  transport.onServerRows = (rows) => delivered.push(rows.map((r) => ({ role: r.role })));

  // The fire opens the idle buffer, then the user submits mid-turn.
  transport.dispatch({ type: "message", id: "1", role: "user", text: "[scheduled: x] y" });
  transport.dispatch({ type: "tool_start", callId: "c1", tool: "read", args: {} });
  const stream = await transport.sendMessages({ trigger: "submit-message", messages: [msg("mine")] });
  // The submit STEERS the same run: its head rows deliver now (they are
  // the conversation's head), the remainder renders through the stream.
  transport.dispatch({ type: "tool_end", callId: "c1", tool: "read", result: "r", isError: false });
  transport.dispatch({ type: "message", id: "2", role: "assistant", text: "fire reply" });
  transport.dispatch({ type: "run_settled" });
  await drain(stream);
  assert.equal(delivered.length, 1, "the steered run's head rows deliver at submit");
  assert.deepEqual(
    delivered[0]!.map((r) => r.role),
    ["user", "tool"],
    "the head (prompt + started tool) renders; the stream owns the rest",
  );
  assert.deepEqual(transport.drainHeldRows(), [], "nothing held with a live sink");
});

test("idle verdicts ride the collected turn: an approval event becomes a verdict row", () => {
  const { transport } = harness();
  const delivered: Array<Array<{ role: string; text?: string }>> = [];
  transport.onServerRows = (rows) => delivered.push(rows.map((r) => ({ role: r.role, text: r.text })));
  transport.dispatch({ type: "message", id: "1", role: "user", text: "[scheduled: x] y" });
  transport.dispatch({ type: "approval", callId: "c1", tool: "browser_open", approved: true });
  transport.dispatch({ type: "message", id: "2", role: "assistant", text: "done" });
  assert.equal(delivered.length, 1);
  assert.deepEqual(
    delivered[0]!.map((r) => r.role),
    ["user", "tool", "assistant"],
    "verdict rows render like any other row in the watched turn",
  );
});

test("replay_done drops an open buffer: backlog rows are the seed, never re-appended", () => {
  const { transport } = harness();
  const delivered: Array<Array<{ role: string; text?: string }>> = [];
  transport.onServerRows = (rows) => delivered.push(rows.map((r) => ({ role: r.role, text: r.text })));
  // A reload lands mid-turn: the backlog replays the turn's head (buffer
  // opens on its user row + tool start), replay_done closes the backlog —
  // those buffered rows must never re-deliver. The turn's tail that
  // arrives LIVE afterward still renders (the solo final rule).
  transport.dispatch({ type: "message", id: "1", role: "user", text: "earlier turn" });
  transport.dispatch({ type: "tool_start", callId: "c1", tool: "read", args: {} });
  transport.dispatch({ type: "replay_done", count: 2 });
  transport.dispatch({ type: "message", id: "2", role: "assistant", text: "late final" });
  transport.dispatch({ type: "run_settled" });
  assert.equal(delivered.length, 1, "only the live tail delivers");
  assert.deepEqual(
    delivered[0]!.map((r) => r.role),
    ["assistant"],
    "the backlog's user row and tool start never re-append",
  );
});

test("a reload mid-turn keeps its tail: post-replay tools open a buffer, the final renders", () => {
  const { transport } = harness();
  const delivered: Array<Array<{ role: string; text?: string }>> = [];
  transport.onServerRows = (rows) => delivered.push(rows.map((r) => ({ role: r.role, text: r.text })));
  // Backlog carries the turn's head; replay_done drops the backlog buffer.
  transport.dispatch({ type: "message", id: "1", role: "user", text: "earlier turn" });
  transport.dispatch({ type: "replay_done", count: 1 });
  assert.equal(delivered.length, 0);
  // The run is still going: its tail arrives live and must render.
  transport.dispatch({ type: "tool_start", callId: "c2", tool: "read", args: {} });
  transport.dispatch({ type: "tool_end", callId: "c2", tool: "read", result: "r", isError: false });
  transport.dispatch({ type: "message", id: "2", role: "assistant", text: "the late reply" });
  assert.equal(delivered.length, 1, "the tail delivers");
  assert.deepEqual(
    delivered[0]!.map((r) => r.role),
    ["tool", "tool", "assistant"],
  );
});

test("a final with no open buffer delivers solo — the reply to a fully-seeded turn", () => {
  const { transport } = harness();
  const delivered: Array<Array<{ role: string; text?: string }>> = [];
  transport.onServerRows = (rows) => delivered.push(rows.map((r) => ({ role: r.role, text: r.text })));
  transport.dispatch({ type: "replay_done", count: 3 });
  transport.dispatch({ type: "message", id: "9", role: "assistant", text: "solo reply" });
  assert.equal(delivered.length, 1);
  assert.deepEqual(delivered[0], [{ role: "assistant", text: "solo reply" }]);
});

test("steering lands inside the open turn — chronological order, no re-keying", () => {
  const { transport } = harness();
  const delivered: Array<Array<{ role: string; text?: string }>> = [];
  transport.onServerRows = (rows) => delivered.push(rows.map((r) => ({ role: r.role, text: r.text })));
  transport.dispatch({ type: "message", id: "1", role: "user", text: "userA asks" });
  transport.dispatch({ type: "message", id: "2", role: "user", text: "userB steers" }); // mid-run
  transport.dispatch({ type: "message", id: "3", role: "assistant", text: "one reply covers both" });
  assert.equal(delivered.length, 1);
  assert.deepEqual(
    delivered[0]!.map((r) => r.text),
    ["userA asks", "userB steers", "one reply covers both"],
    "the steering row stays inside the turn, in arrival order",
  );
});

test("a verdict with no open buffer renders solo; a lone tool result does not", () => {
  const { transport } = harness();
  const delivered: Array<Array<{ role: string; text?: string }>> = [];
  transport.onServerRows = (rows) => delivered.push(rows.map((r) => ({ role: r.role, text: r.text })));
  transport.dispatch({ type: "replay_done", count: 0 });
  transport.dispatch({ type: "tool_end", callId: "c1", tool: "read", result: "late", isError: false });
  transport.dispatch({ type: "approval", callId: "c1", tool: "browser_open", approved: true });
  // The lone tool_end is dropped on purpose: its start row is already in
  // the seed as a running chip, and a solo end would render a SECOND chip
  // instead of completing the seeded one.
  assert.equal(delivered.length, 1);
  assert.deepEqual(delivered[0]!.map((r) => r.role), ["tool"], "the verdict renders alone");
});

test("rows delivered before the sink exists are held and drained at mount", () => {
  const { transport } = harness();
  // No onServerRows wired (ChatSurface not mounted). A fire completes
  // during the boot window — its rows must survive, not vanish.
  transport.dispatch({ type: "message", id: "1", role: "user", text: "[scheduled: x] y" });
  transport.dispatch({ type: "message", id: "2", role: "assistant", text: "early nudge" });
  const held = transport.drainHeldRows();
  assert.deepEqual(
    held.map((r) => r.role),
    ["user", "assistant"],
    "the pre-mount turn survives to the first drain",
  );
  assert.equal(transport.drainHeldRows().length, 0, "draining is one-shot");
});

test("a silent buffer flushes on its backstop timer — the rows arrive once, the timer disarms", async () => {
  const { transport } = harness({ idleFlushMs: 10 });
  const delivered: Array<Array<{ role: string }>> = [];
  transport.onServerRows = (rows) => delivered.push(rows.map((r) => ({ role: r.role })));
  // A turn whose terminal event never comes (reaped agent, stalled run).
  transport.dispatch({ type: "message", id: "1", role: "user", text: "watched" });
  transport.dispatch({ type: "tool_start", callId: "c1", tool: "read", args: {} });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(delivered.length, 1, "the backstop delivers what was collected");
  assert.deepEqual(
    delivered[0]!.map((r) => r.role),
    ["user", "tool"],
  );
  // Disarmed: no second delivery later, and a fresh buffer opens on the
  // next turn without leaking the old one.
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(delivered.length, 1);
});

test("a runaway turn flushes at the cap and keeps collecting — no null push", () => {
  const { transport } = harness({ maxIdleRows: 3 });
  const delivered: Array<Array<{ role: string }>> = [];
  transport.onServerRows = (rows) => delivered.push(rows.map((r) => ({ role: r.role })));
  transport.dispatch({ type: "message", id: "1", role: "user", text: "run" });
  for (let i = 0; i < 8; i++) {
    transport.dispatch({ type: "tool_start", callId: `c${i}`, tool: "read", args: {} });
  }
  transport.dispatch({ type: "message", id: "2", role: "assistant", text: "finally" });
  const total = delivered.reduce((n, b) => n + b.length, 0);
  assert.ok(delivered.length >= 2, "the cap flushed mid-run at least once");
  assert.equal(total, 10, "every row delivered across the flushes, none dropped, no throw");
  assert.deepEqual(
    delivered[delivered.length - 1]!.slice(-1).map((r) => r.role),
    ["assistant"],
  );
});

test("backlog-turn completions never outlive the seed: replay_done clears held rows too", () => {
  const { transport } = harness();
  // A completed turn replays over the backlog while the sink is unwired —
  // its rows would land in heldRows and, drained at mount, render the
  // whole conversation twice. replay_done must clear them.
  transport.dispatch({ type: "message", id: "1", role: "user", text: "old turn" });
  transport.dispatch({ type: "message", id: "2", role: "assistant", text: "old reply" });
  transport.dispatch({ type: "replay_done", count: 2 });
  assert.equal(transport.drainHeldRows().length, 0, "the backlog's completions are the seed's");
  // A live fire completing in the mount window (after replay_done) still holds.
  transport.dispatch({ type: "message", id: "3", role: "user", text: "[scheduled: x] y" });
  transport.dispatch({ type: "message", id: "4", role: "assistant", text: "nudge" });
  assert.deepEqual(
    transport.drainHeldRows().map((r) => r.role),
    ["user", "assistant"],
    "only post-replay turns survive to the drain",
  );
});
