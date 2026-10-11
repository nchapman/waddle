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
  private file: string;

  /** `fileName` separates key domains over one volume: two logs sealed
   *  under different keys MUST not share a file (a restored volume would
   *  try to read one domain's lines with the other key and crash the
   *  boot). Today every session — attended or autonomous — seals with
   *  the master-derived key and uses the default name; the seam stays
   *  for any future key-domain split (and its test). */
  constructor(
    private logKey: Buffer,
    private storage: "disk" | "memory" = "disk",
    fileName = "events.jsonl",
  ) {
    this.file = join(DATA_DIR, "log", fileName);
    if (storage === "disk") {
      mkdirSync(join(DATA_DIR, "log"), { recursive: true });
      if (existsSync(this.file)) {
        for (const line of readFileSync(this.file, "utf8").split("\n")) {
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
      appendFileSync(this.file, sealed.toString("base64") + "\n");
    }
    this.events.push(event);
    this.seq++;
  }
}
