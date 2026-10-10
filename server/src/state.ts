/**
 * The lock: pre-unlock the server holds nothing but a sealed verifier.
 * The client's secret derives the verifier key and, per unlock transcript
 * (secret + nonce), the session credential. Wrong secret → AEAD open
 * fails → 401. Reboot wipes all keys from memory → locked again.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { derive, seal, open, hmac } from "./keys.js";

const DATA_DIR = process.env.DATA_DIR ?? "/tmp/waddle-data";
export { DATA_DIR };
const VERIFIER_FILE = join(DATA_DIR, "verifier.bin");
const VERIFIER_PLAINTEXT = Buffer.from("waddle-unlock-check");
const RATE_LIMIT = { max: 5, windowMs: 60_000 };
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

interface Session {
  token: string;
  createdAt: number;
}

export class Lock {
  unlocked = false;
  enrolled = false;
  private verifierKey: Buffer | null = null;
  private sessions = new Map<string, Session>();
  private attempts: number[] = [];

  /** "memory" = no writable storage found (ephemeral enrollment per boot). */
  readonly storage: "disk" | "memory" = "disk";
  readonly dataDir: string = DATA_DIR;

  constructor() {
    try {
      mkdirSync(DATA_DIR, { recursive: true });
    } catch {
      this.storage = "memory";
      return;
    }
    if (existsSync(VERIFIER_FILE)) this.enrolled = true;
  }

  /** dataDir key material accessor — the event log key, post-unlock. */
  get logKey(): Buffer {
    if (!this.verifierKey) throw new Error("locked");
    return derive(this.verifierKey, "log");
  }

  private checkRate(): void {
    const now = Date.now();
    this.attempts = this.attempts.filter((t) => now - t < RATE_LIMIT.windowMs);
    if (this.attempts.length >= RATE_LIMIT.max) {
      throw Object.assign(new Error("too many unlock attempts"), { statusCode: 429 });
    }
    this.attempts.push(now);
  }

  unlock(secretB64: string, nonceB64: string): { token: string; enrolled: boolean } {
    this.checkRate();
    const secret = Buffer.from(secretB64, "base64");
    const nonce = Buffer.from(nonceB64, "base64");
    if (secret.length !== 64) throw Object.assign(new Error("secret must be 64 bytes"), { statusCode: 400 });

    const verifierKey = derive(secret, "verifier");
    if (this.storage === "disk") {
      if (this.enrolled) {
        let ok = false;
        try {
          ok = VERIFIER_PLAINTEXT.equals(open(verifierKey, readFileSync(VERIFIER_FILE), "verifier"));
        } catch {
          ok = false;
        }
        if (!ok) throw Object.assign(new Error("wrong secret"), { statusCode: 401 });
      } else {
        writeFileSync(VERIFIER_FILE, seal(verifierKey, VERIFIER_PLAINTEXT, "verifier"));
        this.enrolled = true;
      }
    } else {
      this.enrolled = true; // ephemeral: TOFU enrollment per boot
    }

    // Session credential from THIS transcript: secret + fresh nonce.
    const sessionKey = derive(secret, "session", nonce);
    const token = hmac(sessionKey, "waddle-session-token");
    this.sessions.set(token, { token, createdAt: Date.now() });
    this.verifierKey = verifierKey;
    this.unlocked = true;
    return { token, enrolled: this.enrolled };
  }

  verify(token: string | undefined): boolean {
    if (!token || !this.unlocked) return false;
    const s = this.sessions.get(token);
    if (!s) return false;
    if (Date.now() - s.createdAt > SESSION_TTL_MS) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  /** The autonomy subkey's unlock. Deliberately TOFU — no verifier file
   *  is read or written: possession of the escrow IS the authorization
   *  (the concierge's fire-window gated its release), and the subkey must
   *  never touch the master's enrollment. The session and log keys derive
   *  from the subkey root, so the autonomous log is a separate artifact
   *  from the user's — it lives in memory and the postbox, nothing else.
   *  A user unlock later works exactly as before (the master verifier was
   *  never consulted here). */
  unlockAutonomous(keyB64: string): { token: string; logKey: Buffer } {
    this.checkRate();
    const root = Buffer.from(keyB64, "base64");
    if (root.length !== 32) throw Object.assign(new Error("autonomy key must be 32 bytes"), { statusCode: 400 });
    const nonce = freshNonce();
    const sessionKey = derive(root, "session", Buffer.from(nonce, "base64"));
    const token = hmac(sessionKey, "waddle-session-token");
    this.sessions.set(token, { token, createdAt: Date.now() });
    this.unlocked = true;
    return { token, logKey: derive(root, "log") };
  }
}

export function freshNonce(): string {
  return randomBytes(16).toString("base64");
}
