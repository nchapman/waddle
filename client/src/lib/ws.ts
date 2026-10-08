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
  socket.onmessage = (msg) => onEvent(JSON.parse(String(msg.data)) as ServerEvent);
  socket.onclose = onClose;
  return {
    send: (intent) => socket.send(JSON.stringify(intent)),
    close: () => socket.close(),
  };
}
