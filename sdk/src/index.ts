/**
 * @waddle/sdk — the wire contract between the gateway (VM) and clients.
 *
 * One append-only event log per VM. Clients attach: replay from a cursor,
 * then stream live. Clients send intents only — never history.
 * (Phase 1 replaces these stubs with the full protocol.)
 */

export interface HelloResponse {
  service: "waddle-server";
  version: string;
  /** Pre-unlock, only the unlock endpoint exists (the lock screen). */
  locked: boolean;
}

export type GatewayEvent =
  | { type: "hello"; hello: HelloResponse }
  | { type: "task_started"; taskId: string; goal: string }
  | { type: "message"; eventId: string; role: "user" | "assistant"; text: string }
  | { type: "sleep_proposed"; reason: string }
  | { type: "sleep_cancelled"; reason: string };

export function hello(version: string, locked = false): HelloResponse {
  return { service: "waddle-server", version, locked };
}
