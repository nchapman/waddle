/**
 * The chat surface: assistant-ui runtime + AI SDK useChat over the
 * WaddleChatTransport (First Light's substitution, closed). The thread is
 * composed from ThreadPrimitive so the waddle look stays ours.
 */
import { AssistantRuntimeProvider, ComposerPrimitive, MessagePrimitive, ThreadPrimitive } from "@assistant-ui/react";
import { useChatRuntime } from "@assistant-ui/react-ai-sdk";
import type { UIMessage } from "@ai-sdk/react";
import type { ReactNode } from "react";
import type { WaddleChatTransport } from "./lib/waddle-transport";

const UserMessage = () => (
  <MessagePrimitive.Root
    style={{
      alignSelf: "flex-end",
      background: "#dcedf8",
      borderRadius: 10,
      padding: "0.5rem 0.8rem",
      maxWidth: "80%",
      whiteSpace: "pre-wrap",
    }}
  >
    <MessagePrimitive.Content />
  </MessagePrimitive.Root>
);

const AssistantMessage = () => (
  <MessagePrimitive.Root
    style={{
      alignSelf: "flex-start",
      background: "#f1f1f1",
      borderRadius: 10,
      padding: "0.5rem 0.8rem",
      maxWidth: "80%",
      whiteSpace: "pre-wrap",
    }}
  >
    <MessagePrimitive.Content />
  </MessagePrimitive.Root>
);

export function ChatSurface(props: {
  transport: WaddleChatTransport;
  initialMessages: UIMessage[];
  header: ReactNode;
  banner: ReactNode;
}) {
  const runtime = useChatRuntime({ transport: props.transport, messages: props.initialMessages });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div
        style={{
          border: "1px solid #ddd",
          borderRadius: 12,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          height: 520,
          background: "#fff",
        }}
      >
        {props.header}
        {props.banner}
        <ThreadPrimitive.Viewport
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "0.75rem",
            display: "flex",
            flexDirection: "column",
            gap: "0.5rem",
            background: "#fafafa",
          }}
        >
          <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
        </ThreadPrimitive.Viewport>
        <ComposerPrimitive.Root asChild>
          <form
            style={{
              display: "flex",
              gap: "0.5rem",
              padding: "0.6rem",
              borderTop: "1px solid #eee",
              background: "#fff",
            }}
          >
            <ComposerPrimitive.Input asChild>
              <input
                placeholder="talk to your agent…"
                style={{ flex: 1, padding: "0.5rem 0.8rem", fontFamily: "inherit", fontSize: 14 }}
              />
            </ComposerPrimitive.Input>
            <ComposerPrimitive.Send asChild>
              <button style={{ padding: "0.5rem 1.2rem", fontFamily: "inherit" }}>send</button>
            </ComposerPrimitive.Send>
          </form>
        </ComposerPrimitive.Root>
      </div>
    </AssistantRuntimeProvider>
  );
}
