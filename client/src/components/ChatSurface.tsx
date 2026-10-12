/**
 * The chat surface: assistant-ui's styled registry Thread over the
 * WaddleChatTransport (First Light's substitution, closed).
 *
 * Turns this client never submitted — a scheduled fire's nudge, another
 * browser's words — still have to land in the thread. The runtime reads
 * initialMessages exactly once (at mount), so the live channel is the
 * runtime's own chat: useAISDKChat() exposes its helpers (documented for
 * exactly this "advanced views" case) and setMessages appends the
 * completed rows locally, no run, no re-seed.
 */
import { useChatRuntime, useAISDKChat } from "@assistant-ui/react-ai-sdk";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import type { UIMessage } from "@ai-sdk/react";
import { useEffect, useRef } from "react";
import { Thread } from "@/components/assistant-ui/elements/thread.aui";
import { WaddleToolChip } from "./WaddleToolChip";
import { rekeyLiveBatch } from "../lib/history";
import type { WaddleChatTransport } from "../lib/waddle-transport";

function ServerRowsBridge({ transport }: { transport: WaddleChatTransport }) {
  const chat = useAISDKChat();
  // rowsToUIMessages derives ids from row indexes WITHIN a batch — unique
  // inside the seed, colliding across batches. Appended turns get a
  // monotonic prefix on message ids and tool call ids alike.
  const seq = useRef(0);
  useEffect(() => {
    if (!chat) return; // thread not backed by the ai-sdk runtime (never here)
    transport.onServerRows = (rows) => {
      chat.setMessages((messages) => [...messages, ...rekeyLiveBatch(rows, seq.current++)]);
    };
    // A turn that completed before this mount (a fire during boot) held
    // its rows — drain them now that the sink exists.
    const held = transport.drainHeldRows();
    if (held.length > 0) {
      chat.setMessages((messages) => [...messages, ...rekeyLiveBatch(held, seq.current++)]);
    }
    return () => {
      transport.onServerRows = null;
    };
  }, [transport, chat]);
  return null;
}

export function ChatSurface(props: { transport: WaddleChatTransport; initialMessages: UIMessage[] }) {
  const runtime = useChatRuntime({ transport: props.transport, messages: props.initialMessages });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ServerRowsBridge transport={props.transport} />
      <Thread autoFocus components={{ ToolFallback: WaddleToolChip }} />
    </AssistantRuntimeProvider>
  );
}
