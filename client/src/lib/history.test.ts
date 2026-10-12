import { test } from "node:test";
import assert from "node:assert/strict";
import type { UIMessage } from "@ai-sdk/react";
import {
  eventsToRows,
  rowsToUIMessages,
  rekeyLiveBatch,
  parseToolText,
  toolStartRow,
  toolEndRow,
  type ChatMessage,
} from "./history.js";

const dynamicParts = (m: UIMessage) => m.parts.filter((p) => p.type === "dynamic-tool");

test("eventsToRows maps sealed events to surface rows", () => {
  const rows = eventsToRows([
    { type: "message", role: "user", text: "hi" },
    { type: "message", role: "assistant", text: "hello" },
    { type: "tool_start", tool: "browser_open", args: { url: "example.com" } },
    { type: "tool_end", tool: "browser_open", result: "page", isError: false },
    { type: "sleep", reason: "idle" }, // not history-bearing — dropped
  ]);
  assert.deepEqual(
    rows.map((r) => r.role),
    ["user", "assistant", "tool", "tool"],
  );
  assert.deepEqual(rows[2]!.tool, { name: "browser_open", args: { url: "example.com" } });
  assert.deepEqual(rows[3]!.tool, { name: "browser_open", result: "page", isError: false });
});

test("row builders round-trip through the legacy mono format", () => {
  const start = toolStartRow("read", { path: "/a" });
  const end = toolEndRow("read", "contents", false);
  assert.deepEqual(parseToolText(start.text), { name: "read", args: { path: "/a" } });
  assert.deepEqual(parseToolText(end.text), { name: "read", result: "contents", isError: false });
  const failed = toolEndRow("codemode", "exit 1", true);
  assert.equal(parseToolText(failed.text)!.isError, true);
});

test("rowsToUIMessages pairs tool start+end rows into one dynamic-tool part", () => {
  const rows = eventsToRows([
    { type: "message", role: "user", text: "open it" },
    { type: "tool_start", tool: "browser_open", args: { url: "example.com" } },
    { type: "tool_end", tool: "browser_open", result: "ok", isError: false },
    { type: "message", role: "assistant", text: "done" },
  ]);
  const msgs = rowsToUIMessages(rows);
  assert.equal(msgs.length, 2); // user, then one assistant message (tool part + text)
  assert.equal(msgs[1]!.role, "assistant");
  assert.equal(msgs[1]!.parts.length, 2); // dynamic-tool + trailing text
  const parts = dynamicParts(msgs[1]!);
  assert.equal(parts.length, 1);
  const tool = parts[0] as { state: string; input: unknown; output: unknown };
  assert.equal(tool.state, "output-available");
  assert.deepEqual(tool.input, { url: "example.com" });
  assert.equal(tool.output, "ok");
});

test("rowsToUIMessages: a start-only row (crash/interrupt) stays input-available", () => {
  const rows = eventsToRows([
    { type: "tool_start", tool: "codemode", args: { code: "long" } },
    // no tool_end — the run died mid-call
  ]);
  const msgs = rowsToUIMessages(rows);
  const tool = dynamicParts(msgs[0]!)[0] as { state: string };
  assert.equal(tool.state, "input-available");
});

test("rowsToUIMessages: an errored pair renders output-error", () => {
  const rows = eventsToRows([
    { type: "tool_start", tool: "codemode", args: { code: "x" } },
    { type: "tool_end", tool: "codemode", result: "boom", isError: true },
  ]);
  const tool = dynamicParts(rowsToUIMessages(rows)[0]!)[0] as { state: string; errorText: string };
  assert.equal(tool.state, "output-error");
  assert.equal(tool.errorText, "boom");
});

test("rowsToUIMessages: adjacent calls of the same tool still pair correctly", () => {
  const rows = eventsToRows([
    { type: "tool_start", tool: "read", args: { path: "1" } },
    { type: "tool_end", tool: "read", result: "one", isError: false },
    { type: "tool_start", tool: "read", args: { path: "2" } },
    { type: "tool_end", tool: "read", result: "two", isError: false },
  ]);
  const parts = dynamicParts(rowsToUIMessages(rows)[0]!);
  assert.equal(parts.length, 2);
  assert.equal((parts[1] as { output: unknown }).output, "two");
});

test("an orphan end row (start absent or consumed) still renders its result", () => {
  const messages = rowsToUIMessages([toolEndRow("codemode", "late result", false)]);
  const parts = messages[0]!.parts.filter((p) => p.type === "dynamic-tool");
  assert.equal(parts.length, 1);
  const part = parts[0] as { state: string; input: unknown; output: unknown };
  assert.equal(part.state, "output-available");
  assert.deepEqual(part.input, {});
  assert.equal(part.output, "late result");
});

test("parseToolText keeps malformed args/results as raw text — replay never crashes", () => {
  // Start row whose args are not valid JSON: name survives, args stay raw.
  assert.deepEqual(parseToolText("⚙️ read {not json}"), { name: "read", args: "{not json}" });
  // End row whose result excerpt was truncated mid-JSON: keep the text.
  const t = parseToolText('✔ read → {"path":"/a","con');
  assert.equal(t!.name, "read");
  assert.equal(t!.result, '{"path":"/a","con');
  assert.equal(t!.isError, false);
  // Plain prose is not a tool row.
  assert.equal(parseToolText("just talking"), undefined);
});

test("rekeyLiveBatch: batches get unique message and tool-call ids across the seed and each other", () => {
  const turn: ChatMessage[] = [
    { role: "user", text: "go" },
    toolStartRow("read", { path: "/x" }),
    toolEndRow("read", "ok", false),
    { role: "assistant", text: "done" },
  ];
  // The seed would render this same shape with ids h0… — live batches must
  // never collide with it or with each other.
  const a = rekeyLiveBatch(turn, 0);
  const b = rekeyLiveBatch(turn, 1);
  const seed = rowsToUIMessages(turn);
  const ids = new Set<string>();
  for (const m of [...seed, ...a, ...b]) {
    assert.ok(!ids.has(m.id), `duplicate message id ${m.id}`);
    ids.add(m.id);
    for (const p of m.parts) {
      if (p.type === "dynamic-tool") {
        assert.ok(!ids.has(p.toolCallId), `duplicate toolCallId ${p.toolCallId}`);
        ids.add(p.toolCallId);
      }
    }
  }
  assert.equal(a.length, 2, "user + assistant messages per turn");
});
