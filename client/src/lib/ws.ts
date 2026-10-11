/**
 * The chat channel: gated WSS with the session token. Browsers cannot set
 * WS headers, so the token rides the query string over the enclave's TLS
 * (the plan's accepted fallback until attested WSS lands).
 */
import type { GatewayEvent, DeltaEvent, ErrorEvent, UserIntent } from "@waddle/sdk";

export type ServerEvent = GatewayEvent | DeltaEvent | ErrorEvent;

export interface ChatConnection {
  send: (intent: UserIntent) => void;
  close: () => void;
}

/** The socket surface connectChat drives (tests inject a fake; the
 *  browser's WebSocket satisfies it structurally). */
export interface ChatSocket {
  send(data: string): void;
  close(): void;
  onmessage: ((msg: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
}

export function connectChat(
  enclaveURL: string,
  token: string,
  onEvent: (event: ServerEvent) => void,
  onClose: () => void,
  makeSocket: (url: string) => ChatSocket = (url) => new WebSocket(url) as unknown as ChatSocket,
): ChatConnection {
  const wsURL = `${enclaveURL.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(token)}`;
  const socket = makeSocket(wsURL);
  // Replay guard: events before replay_done are history. Sleep events in the
  // backlog are records of past naps — reacting to them would re-sleep a
  // freshly woken enclave.
  let replayed = false;
  socket.onmessage = (msg) => {
    const event = JSON.parse(String(msg.data)) as ServerEvent;
    if (event.type === "replay_done") {
      replayed = true;
    }
    if (!replayed && (event.type === "sleep" || event.type === "sleep_proposed")) return;
    onEvent(event);
  };
  socket.onclose = onClose;
  return {
    send: (intent) => socket.send(JSON.stringify(intent)),
    close: () => socket.close(),
  };
}
