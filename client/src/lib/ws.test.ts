/**
 * connectChat tests — the replay guard is the contract: sleep events that
 * arrive in the sealed-log backlog must NOT re-sleep a freshly woken
 * enclave, while live ones (post replay_done) must. Drives a fake socket
 * via the injected factory; no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { connectChat, type ChatSocket } from "./ws.js";

class FakeSocket implements ChatSocket {
  sent: string[] = [];
  closed = false;
  onmessage: ((msg: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  /** Test helper: the "server" speaks. */
  receive(event: unknown): void {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
}

function harness() {
  const socket = new FakeSocket();
  const events: Array<{ type: string; [k: string]: unknown }> = [];
  const closes = { n: 0 };
  let givenUrl = "";
  const conn = connectChat(
    "https://waddle-uabcdef12-345678.ddg-waddle.containers.tinfoil.dev",
    "tok/en+1",
    (e) => events.push(e as { type: string }),
    () => closes.n++,
    (url) => {
      givenUrl = url;
      return socket;
    },
  );
  return { socket, events, closes, conn, givenUrl };
}

test("the ws URL upgrades the scheme and query-encodes the session token", () => {
  const { givenUrl } = harness();
  assert.equal(
    givenUrl,
    "wss://waddle-uabcdef12-345678.ddg-waddle.containers.tinfoil.dev/ws?token=tok%2Fen%2B1",
  );
});

test("backlog sleep events are swallowed; live ones pass after replay_done", () => {
  const { socket, events } = harness();
  socket.receive({ type: "message", role: "user", text: "old" }); // backlog passes through (not sleep)
  socket.receive({ type: "sleep", reason: "idle 600s (no activity)" }); // a PAST nap — must not re-sleep
  socket.receive({ type: "replay_done", count: 2 });
  socket.receive({ type: "sleep", reason: "user requested" }); // a LIVE nap — must surface
  assert.deepEqual(
    events.map((e) => [e.type, e.role ?? e.reason]),
    [
      ["message", "user"],
      ["replay_done", undefined],
      ["sleep", "user requested"],
    ],
  );
});

test("intents serialize onto the socket; close relays to onClose", () => {
  const { socket, closes, conn } = harness();
  conn.send({ type: "sleep_now" });
  assert.deepEqual(socket.sent, ['{"type":"sleep_now"}']);
  assert.equal(closes.n, 0);
  conn.close();
  assert.equal(socket.closed, true);
  socket.onclose?.();
  assert.equal(closes.n, 1);
});
