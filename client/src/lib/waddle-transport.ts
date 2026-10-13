/**
 * The bridge: assistant-ui/AI SDK useChat ↔ waddle's gated WSS.
 *
 * sendMessages() hands the user's text to the enclave gateway and maps the
 * gateway's event stream into UIMessageChunks: deltas stream, tool activity
 * rides as real tool parts (the Thread renders them as chips), approval
 * verdicts ride as fenced text, run_settled closes the turn (steered and
 * queued replies all land first).
 *
 * Chunk protocol (learned the hard way): 'start' opens the message,
 * 'text-start' opens the part BEFORE any text-delta, and text-end + finish
 * close. A delta for an unopened part is dropped — and can kill the stream —
 * so every text path goes through ensureText().
 */
import type { UIMessage } from "@ai-sdk/react";
import type { ChatTransport, UIMessageChunk } from "ai";
import type { UserIntent } from "@waddle/sdk";
import type { ServerEvent } from "./ws";
import { toolEndRow, toolStartRow, approvalRow, type ChatMessage } from "./history";

type Tap = (event: ServerEvent) => void;

/** Completed rows of a turn this client never submitted — a scheduled
 *  fire, another browser's words. Delivered whole at run_settled so
 *  tool start/end pairs map to single chips (rowsToUIMessages pairs at
 *  seed time); the surface appends them to its chat. */
export type ServerRowsSink = (rows: ChatMessage[]) => void;

const text = (delta: string): UIMessageChunk => ({ type: "text-delta", delta, id: "w" });
const short = (s: string, n = 140): string => (s.length > n ? `${s.slice(0, n)}…` : s);

export class WaddleChatTransport implements ChatTransport<UIMessage> {
  private sendIntent: ((intent: UserIntent) => void) | null = null;
  private tap: Tap | null = null;
  private appTap: Tap | null = null;
  /** Idle-turn rows sink (ChatSurface wires its chat here). */
  onServerRows: ServerRowsSink | null = null;
  /** Rows of an idle turn in flight (null = none open). */
  private idleRows: ChatMessage[] | null = null;
  /** Rows delivered before the sink existed (ChatSurface drains on mount). */
  private heldRows: ChatMessage[] = [];
  /** Backstop for a turn whose terminal event never comes. */
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** A cancel whose stop intent hasn't left yet (the steering grace —
   *  see the abort listener in sendMessages). */
  private stopIntentTimer: ReturnType<typeof setTimeout> | null = null;
  /** Collected rows beyond this deliver immediately (a runaway turn must
   *  not grow the buffer unbounded). */
  private maxIdleRows: number;
  /** How long a silent buffer waits before delivering what it has. */
  private idleFlushMs: number;
  /** Held rows bound (no-sink window only — drains are one-shot). */
  private static readonly MAX_HELD_ROWS = 1000;

  constructor(opts?: { idleFlushMs?: number; maxIdleRows?: number }) {
    this.idleFlushMs = opts?.idleFlushMs ?? 90_000;
    this.maxIdleRows = opts?.maxIdleRows ?? 500;
  }

  /** ChatSurface mounted: drain anything the sink missed. */
  drainHeldRows(): ChatMessage[] {
    const rows = this.heldRows;
    this.heldRows = [];
    return rows;
  }

  /** The App wires the live socket here once the gateway connection opens. */
  attach(sendIntent: (intent: UserIntent) => void): void {
    this.sendIntent = sendIntent;
  }

  /** The socket died: finish any open stream so the turn can never hang. */
  detach(): void {
    this.sendIntent = null;
    this.idleRows = null; // the replay on reconnect re-delivers the turn
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.stopIntentTimer) {
      clearTimeout(this.stopIntentTimer);
      this.stopIntentTimer = null;
    }
    this.tap?.({ type: "error", message: "connection lost — reload to re-replay" });
    this.tap = null;
  }

  /** True while a locally-submitted turn's stream is open. App gates
   *  state appends on this: a streaming client renders the turn through
   *  its own stream, an idle one — a scheduled nudge, another browser's
   *  words — collects it via onServerRows instead. */
  isStreaming(): boolean {
    return this.tap !== null;
  }

  /** Non-chat events (approvals, sleep) still reach the App. */
  setAppTap(tap: Tap): void {
    this.appTap = tap;
  }

  /** Every server event flows through here. */
  dispatch(event: ServerEvent): void {
    this.appTap?.(event);
    this.tap?.(event);
    this.collectIdle(event);
  }

  /** Turns nobody here submitted still render: while idle, a broadcast
   *  user row opens a buffer, its tools/final fill it, the assistant
   *  final delivers it whole. Order is chronological truth — a steering
   * user row mid-turn APPENDS (not re-keys), and a final with no open
   * buffer delivers solo (the tail of a turn whose head was in the
   * backlog/seed). The streaming client ignores all of this — its tap
   * renders the same events, and a duplicate row would follow its live
   * stream. */
  private collectIdle(event: ServerEvent): void {
    if (this.tap) return; // local turn live — the tap owns rendering
    const deliver = (rows: ChatMessage[] | null): void => {
      if (!rows || rows.length === 0) return;
      if (this.onServerRows) this.onServerRows(rows);
      // No sink yet (pre-mount window): hold for the drain, bounded — the
      // drain is one-shot per mount and must never grow unbounded.
      else this.heldRows.push(...rows.slice(0, WaddleChatTransport.MAX_HELD_ROWS));
    };
    const armTimer = (): void => {
      if (this.idleTimer) return;
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        // A run whose terminal event never came (reaped agent, stalled
        // provider, ws still open): deliver what was collected rather
        // than holding it until an unrelated boundary.
        const rows = this.idleRows;
        this.idleRows = null;
        deliver(rows);
      }, this.idleFlushMs);
    };
    const disarmTimer = (): void => {
      if (this.idleTimer) {
        clearTimeout(this.idleTimer);
        this.idleTimer = null;
      }
    };
    // Every row appends through one capped path: a runaway turn must not
    // grow the buffer unbounded no matter which event kind feeds it.
    const push = (row: ChatMessage): void => {
      (this.idleRows ??= []).push(row);
      armTimer();
      if (this.idleRows!.length >= this.maxIdleRows) {
        deliver(this.idleRows!);
        this.idleRows = []; // re-open: the turn keeps going, bounded
      }
    };
    if (event.type === "message" && event.role === "user") {
      // Steering lands mid-run: the same conversation continues, so the
      // row belongs INSIDE the open turn (chronological order), not a
      // fresh buffer that would re-key the run's rows.
      push({ role: "user", text: event.text });
      return;
    }
    if (event.type === "tool_start") {
      push(toolStartRow(event.tool, event.args ?? {})); // or a seeded turn's tail
      return;
    }
    if (event.type === "replay_done") {
      // The backlog IS the seed — anything it delivered (buffered rows OR
      // held completions) duplicates history the mounted thread already
      // has. Clear both; only rows held AFTER this point (a live fire in
      // the mount window) survive to the drain.
      this.idleRows = null;
      this.heldRows = [];
      disarmTimer();
      return;
    }
    if (!this.idleRows) {
      if (event.type === "message" && event.role === "assistant") {
        // The reply to a turn whose head the backlog already seeded —
        // deliver it solo rather than dropping the reload's tail.
        deliver([{ role: "assistant", text: event.text }]);
      }
      if (event.type === "approval") {
        // Verdicts are sealed but requests are not — a reload between ask
        // and answer seeds no head at all; render the verdict row alone.
        deliver([approvalRow(event.tool, event.approved)]);
      }
      // A lone tool_end does NOT render: its start row is already in the
      // seed as a running chip, and a solo end row would pair into a NEW
      // chip (duplicate) instead of completing the seeded one — cross-
      // batch chip completion is a renderer upgrade, not a transport fix.
      return;
    }
    if (event.type === "tool_end") {
      push(toolEndRow(event.tool, event.result, event.isError));
      return;
    }
    if (event.type === "approval") {
      push(approvalRow(event.tool, event.approved));
      return;
    }
    if (event.type === "message" && event.role === "assistant") {
      // The final completes the turn for rendering purposes; settled/error
      // are backstops (a run that dies mid-turn never settles, and the
      // buffer must not wait forever for it).
      const rows = [...this.idleRows, { role: "assistant" as const, text: event.text }];
      this.idleRows = null;
      disarmTimer();
      deliver(rows);
      return;
    }
    if (event.type === "run_settled" || event.type === "error") {
      const rows = this.idleRows; // late settle after the final, or a
      this.idleRows = null; // turn that never finished — deliver what ran
      disarmTimer();
      deliver(rows);
    }
  }

  async sendMessages(options: {
    trigger: "submit-message" | "regenerate-message";
    messages: UIMessage[];
    abortSignal?: AbortSignal;
  }): Promise<ReadableStream<UIMessageChunk>> {
    const last = options.messages[options.messages.length - 1];
    const userText =
      last?.role === "user" ? last.parts.map((p) => (p.type === "text" ? p.text : "")).join("") : "";
    if (!userText.trim()) {
      return new ReadableStream({
        start: (c) => {
          c.close();
        },
      });
    }

    // A new stream supersedes any open one (steering/queueing). A
    // half-collected idle turn is the SAME run being steered — deliver
    // its head rows now (the stream renders the rest live), never a stale
    // flush at an unrelated boundary. It also cancels a pending cancel's
    // stop intent: a submit-while-running aborts the old stream first,
    // and that abort must never stop the run the new message steers.
    if (this.idleRows) {
      const rows = this.idleRows;
      this.idleRows = null;
      if (this.idleTimer) {
        clearTimeout(this.idleTimer);
        this.idleTimer = null;
      }
      this.onServerRows?.(rows);
    }
    if (this.stopIntentTimer) {
      clearTimeout(this.stopIntentTimer);
      this.stopIntentTimer = null;
    }
    this.tap = null;
    const sendIntent = this.sendIntent;
    const self = this;

    return new ReadableStream<UIMessageChunk>({
      start(controller) {
        controller.enqueue({ type: "start" });
        let open = true;
        let textOpen = false;
        // The part must be opened before ANY text-delta — tool lines and
        // verdicts can precede the model's first word.
        const ensureText = () => {
          if (!open) return;
          if (!textOpen) {
            textOpen = true;
            controller.enqueue({ type: "text-start", id: "w" });
          }
        };
        // Tool parts must not nest inside an open text part.
        const closeText = () => {
          if (textOpen) {
            textOpen = false;
            controller.enqueue({ type: "text-end", id: "w" });
          }
        };
        const finish = () => {
          if (!open) return;
          open = false;
          if (self.tap === tap) self.tap = null;
          try {
            controller.close();
          } catch {
            /* already closed by the consumer */
          }
        };
        const tap: Tap = (event) => {
          if (!open) return;
          try {
            switch (event.type) {
              case "delta":
                ensureText();
                controller.enqueue(text(event.text));
                break;
              case "tool_start":
                closeText();
                controller.enqueue({ type: "tool-input-start", toolCallId: event.callId, toolName: event.tool });
                controller.enqueue({
                  type: "tool-input-delta",
                  toolCallId: event.callId,
                  inputTextDelta: JSON.stringify(event.args ?? {}),
                });
                break;
              case "tool_end":
                closeText();
                if (event.isError) {
                  controller.enqueue({
                    type: "tool-output-error",
                    toolCallId: event.callId,
                    errorText: short(JSON.stringify(event.result ?? ""), 200),
                  });
                } else {
                  controller.enqueue({
                    type: "tool-output-available",
                    toolCallId: event.callId,
                    output: event.result ?? "",
                  });
                }
                break;
              case "approval":
                ensureText();
                controller.enqueue(
                  text(`\`${event.approved ? "🔓" : "⛔"} ${event.tool} ${event.approved ? "approved" : "denied"} by user\`\n`),
                );
                break;
              case "run_settled":
                // End of turn — steered and queued replies all landed first.
                if (textOpen) controller.enqueue({ type: "text-end", id: "w" });
                controller.enqueue({ type: "finish", finishReason: "stop" });
                finish();
                break;
              case "error":
                if (textOpen) controller.enqueue({ type: "text-end", id: "w" });
                controller.enqueue({ type: "error", errorText: event.message });
                controller.enqueue({ type: "finish", finishReason: "error" });
                finish();
                break;
              default:
                break;
            }
          } catch {
            // The consumer cancelled the stream (its right); stop feeding it.
            finish();
          }
        };
        self.tap = tap;
        options.abortSignal?.addEventListener("abort", () => {
          finish();
          // The runtime aborts the old stream when a NEW submit supersedes
          // it (steering) — indistinguishable here from a genuine cancel at
          // abort time. Grace: hold the stop intent briefly; a superseding
          // sendMessages (top of this method) cancels it. A genuine cancel
          // fires it after the window and the enclave stops the run. The
          // window is generous (a submit follows its abort within a tick
          // in practice; a genuine stop just lands half a second later); a
          // framework gap longer than it would stop a steered run — the
          // "[system] run stopped" row makes that visible, not silent.
          if (self.stopIntentTimer) clearTimeout(self.stopIntentTimer);
          self.stopIntentTimer = setTimeout(() => {
            self.stopIntentTimer = null;
            self.sendIntent?.({ type: "stop" });
          }, 500);
        });
        sendIntent?.({ type: "user_message", text: userText });
      },
    });
  }

  async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    return null; // history arrives via initialMessages + replay, not stream resume
  }
}
