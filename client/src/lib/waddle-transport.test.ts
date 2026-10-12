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

function harness() {
  const transport = new WaddleChatTransport();
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
