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

export function connectChat(
  enclaveURL: string,
  token: string,
  onEvent: (event: ServerEvent) => void,
  onClose: () => void,
): ChatConnection {
  const wsURL = `${enclaveURL.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(token)}`;
  const socket = new WebSocket(wsURL);
  // Replay guard: events before replay_done are history. Sleep events in the
  // backlog are records of past naps — reacting to them would re-sleep a
  // freshly woken enclave (and re-fire the stop relay).
  let replayed = false;
  socket.onmessage = (msg) => {
    const event = JSON.parse(String(msg.data)) as ServerEvent;
    if (event.type === "replay_done") {
      replayed = true;
      return;
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
