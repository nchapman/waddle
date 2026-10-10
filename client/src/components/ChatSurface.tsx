/**
 * The chat surface: assistant-ui's styled registry Thread over the
 * WaddleChatTransport (First Light's substitution, closed). The runtime and
 * transport are untouched — this is purely the presentation upgrade.
 */
import { useChatRuntime } from "@assistant-ui/react-ai-sdk";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import type { UIMessage } from "@ai-sdk/react";
import { Thread } from "@/components/assistant-ui/elements/thread.aui";
import { WaddleToolChip } from "./WaddleToolChip";
import type { WaddleChatTransport } from "../lib/waddle-transport";

export function ChatSurface(props: { transport: WaddleChatTransport; initialMessages: UIMessage[] }) {
  const runtime = useChatRuntime({ transport: props.transport, messages: props.initialMessages });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread autoFocus components={{ ToolFallback: WaddleToolChip }} />
    </AssistantRuntimeProvider>
  );
}
