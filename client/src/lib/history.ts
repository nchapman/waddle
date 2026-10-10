/**
 * History mapping: sealed-log events → surface rows → assistant-ui
 * messages. Pure functions — the one place that knows the (legacy) mono
 * tool-row format and the start/end pairing that rebuilds real tool
 * chips from replayed history. Both the live event handler and the
 * boot-time seed route through here so the formats can never drift.
 */
import type { UIMessage } from "@ai-sdk/react";

export interface ChatMessage {
  role: "user" | "assistant" | "tool";
  text: string;
  error?: boolean;
  /** Structured tool call (live + replay) — the seed renders real chips. */
  tool?: { name: string; args?: unknown; result?: unknown; isError?: boolean };
}

/** Parse the legacy emoji mono format back into structured tool rows. */
export function parseToolText(text: string): ChatMessage["tool"] | undefined {
  const start = /^⚙️ (\S+) (\{.*\})$/s.exec(text);
  if (start) {
    try {
      return { name: start[1]!, args: JSON.parse(start[2]!) as unknown };
    } catch {
      return { name: start[1]!, args: start[2] };
    }
  }
  const end = /^([⛔✔]) (\S+) → (.*)$/s.exec(text);
  if (end) {
    let result: unknown = end[3];
    try {
      result = JSON.parse(end[3]!) as unknown;
    } catch {
      /* result excerpt was truncated — keep the text */
    }
    return { name: end[2]!, result, isError: end[1] === "⛔" };
  }
  return undefined;
}

// ── Row builders: the mono format lives ONLY here ───────────────────────

export function toolStartRow(tool: string, args: unknown): ChatMessage {
  return {
    role: "tool",
    text: `⚙️ ${tool} ${JSON.stringify(args ?? {}).slice(0, 140)}`,
    tool: { name: tool, args: args ?? {} },
  };
}

export function toolEndRow(tool: string, result: unknown, isError: boolean): ChatMessage {
  const r = JSON.stringify(result ?? "").slice(0, 100);
  return {
    role: "tool",
    text: `${isError ? "⛔" : "✔"} ${tool} → ${r}`,
    tool: { name: tool, result: result ?? "", isError },
  };
}

export function approvalRow(tool: string, approved: boolean): ChatMessage {
  return { role: "tool", text: `${approved ? "🔓" : "⛔"} ${tool} ${approved ? "approved" : "denied"} by user` };
}

/** A relayed history row — tool rows get their structured form back via
 *  parseToolText so live relays render the same chips a seeded log does. */
export function historyRow(role: ChatMessage["role"], text: string): ChatMessage {
  return { role, text, ...(role === "tool" ? { tool: parseToolText(text) } : {}) };
}

/** Deterministic history seed: map sealed log events to surface rows. */
export function eventsToRows(events: Array<Record<string, unknown>>): ChatMessage[] {
  const rows: ChatMessage[] = [];
  for (const e of events) {
    const t = e.type as string | undefined;
    if (t === "message" && (e.role === "user" || e.role === "assistant")) {
      rows.push({ role: e.role as "user" | "assistant", text: String(e.text ?? "") });
    } else if (t === "history_row" && typeof e.text === "string") {
      const role = e.role as ChatMessage["role"];
      rows.push(historyRow(role, e.text));
    } else if (t === "tool_start") {
      rows.push(toolStartRow(String(e.tool ?? ""), e.args ?? {}));
    } else if (t === "tool_end") {
      rows.push(toolEndRow(String(e.tool ?? ""), e.result ?? "", !!e.isError));
    }
  }
  return rows;
}

/** History seed for the runtime: rows → UIMessage parts. A completed call
 *  pairs its start row (args) with its end row (result) into one
 *  dynamic-tool part — the same chip the live stream renders. Identity of
 *  the result must stay stable per seed — a fresh array per render makes
 *  the runtime re-sync and wipe live streaming turns, so callers memoize. */
export function rowsToUIMessages(rows: ChatMessage[]): UIMessage[] {
  const out: UIMessage[] = [];
  let assistantParts: UIMessage["parts"] = [];
  const flush = (id: string) => {
    if (assistantParts.length > 0) out.push({ id, role: "assistant", parts: assistantParts });
    assistantParts = [];
  };
  for (let i = 0; i < rows.length; i++) {
    const m = rows[i]!;
    if (m.role === "user") {
      flush(`h${i}a`);
      out.push({ id: `h${i}`, role: "user", parts: [{ type: "text", text: m.text }] });
      continue;
    }
    if (m.role === "tool" && m.tool) {
      const next = rows[i + 1];
      const start = m.tool.result === undefined ? m.tool : undefined;
      if (start && next?.role === "tool" && next.tool?.name === m.tool.name && next.tool.result !== undefined) {
        // A completed call: start row (args) + end row (result), one part.
        assistantParts.push({
          type: "dynamic-tool",
          toolName: m.tool.name,
          toolCallId: `h${i}`,
          state: next.tool.isError ? "output-error" : "output-available",
          input: m.tool.args ?? {},
          ...(next.tool.isError
            ? { errorText: String(next.tool.result ?? "").slice(0, 200) }
            : { output: next.tool.result ?? "" }),
        } as UIMessage["parts"][number]);
        i++; // consumed the end row
        continue;
      }
      if (start) {
        // Start-only (crash/interrupt): the call ran, its result never came.
        assistantParts.push({
          type: "dynamic-tool",
          toolName: m.tool.name,
          toolCallId: `h${i}`,
          state: "input-available",
          input: m.tool.args ?? {},
        } as UIMessage["parts"][number]);
        continue;
      }
      // End row whose start was already consumed or absent.
      assistantParts.push({
        type: "dynamic-tool",
        toolName: m.tool.name,
        toolCallId: `h${i}e`,
        state: m.tool.isError ? "output-error" : "output-available",
        input: {},
        ...(m.tool.isError
          ? { errorText: String(m.tool.result ?? "").slice(0, 200) }
          : { output: m.tool.result ?? "" }),
      } as UIMessage["parts"][number]);
      continue;
    }
    // Plain assistant text, or legacy tool rows without structure.
    assistantParts.push({ type: "text", text: m.role === "tool" ? `\`${m.text}\`` : m.text });
  }
  flush("hz");
  return out;
}
