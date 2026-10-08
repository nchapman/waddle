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
import type { DeltaEvent, ErrorEvent, GatewayEvent, UserIntent } from "@waddle/sdk";

type ServerEvent = GatewayEvent | DeltaEvent | ErrorEvent;
type Tap = (event: ServerEvent) => void;

const text = (delta: string): UIMessageChunk => ({ type: "text-delta", delta, id: "w" });
const short = (s: string, n = 140): string => (s.length > n ? `${s.slice(0, n)}…` : s);

export class WaddleChatTransport implements ChatTransport<UIMessage> {
  private sendIntent: ((intent: UserIntent) => void) | null = null;
  private tap: Tap | null = null;
  private appTap: Tap | null = null;

  /** The App wires the live socket here once the gateway connection opens. */
  attach(sendIntent: (intent: UserIntent) => void): void {
    this.sendIntent = sendIntent;
  }

  /** The socket died: finish any open stream so the turn can never hang. */
  detach(): void {
    this.sendIntent = null;
    this.tap?.({ type: "error", message: "connection lost — reload to re-replay" });
    this.tap = null;
  }

  /** Non-chat events (approvals, sleep) still reach the App. */
  setAppTap(tap: Tap): void {
    this.appTap = tap;
  }

  /** Every server event flows through here. */
  dispatch(event: ServerEvent): void {
    this.appTap?.(event);
    this.tap?.(event);
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

    // A new stream supersedes any open one (steering/queueing).
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
        options.abortSignal?.addEventListener("abort", () => finish());
        sendIntent?.({ type: "user_message", text: userText });
      },
    });
  }

  async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    return null; // history arrives via initialMessages + replay, not stream resume
  }
}
