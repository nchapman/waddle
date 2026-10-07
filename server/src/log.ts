/**
 * The event log: append-only JSONL, each line sealed independently with
 * the log key derived from the client's secret. At rest the file is
 * ciphertext; without the secret there is no history.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { seal, open } from "./keys.js";
import { DATA_DIR } from "./state.js";

const LOG_FILE = join(DATA_DIR, "log", "events.jsonl");

export class EventLog {
  private events: Array<Record<string, unknown>> = [];
  private seq = 0;

  constructor(
    private logKey: Buffer,
    private storage: "disk" | "memory" = "disk",
  ) {
    if (storage === "disk") {
      mkdirSync(join(DATA_DIR, "log"), { recursive: true });
      if (existsSync(LOG_FILE)) {
        for (const line of readFileSync(LOG_FILE, "utf8").split("\n")) {
          if (!line) continue;
          this.events.push(JSON.parse(open(logKey, Buffer.from(line, "base64"), `seq:${this.seq}`).toString()));
          this.seq++;
        }
      }
    }
  }

  get all(): Array<Record<string, unknown>> {
    return this.events;
  }

  append(event: Record<string, unknown>): void {
    if (this.storage === "disk") {
      const sealed = seal(this.logKey, Buffer.from(JSON.stringify(event)), `seq:${this.seq}`);
      appendFileSync(LOG_FILE, sealed.toString("base64") + "\n");
    }
    this.events.push(event);
    this.seq++;
  }
}
