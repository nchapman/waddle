/**
 * Secret redaction. scrubSecrets runs at the transcript boundary — the
 * guard extension's tool_result handler — so a secret that leaks into
 * any tool's output (an echo, a gateway bug, a file the agent read)
 * reaches the model and the session log as [REDACTED:<name>], never as
 * the value. This is belt-and-braces: after env scrubbing children
 * should not be able to produce these values at all.
 */
import { registeredSecrets } from "./policy.js";

/** Replace every registered secret value with its named marker. */
export function scrubSecrets(text: string): string {
  let out = text;
  for (const [name, value] of registeredSecrets()) {
    // split/join: literal replace, no regex-escaping hazards.
    out = out.split(value).join(`[REDACTED:${name}]`);
  }
  return out;
}

/** True when the text contains a registered secret value. */
export function containsSecret(text: string): boolean {
  return registeredSecrets().some(([, value]) => text.includes(value));
}

/**
 * Deep-redact a JsonValue (a tool's structuredContent). Strings are
 * scrubbed; objects/arrays recursed; other primitives pass through.
 * Returns the original reference when nothing matched, so callers can
 * skip constructing a replacement result.
 */
export function scrubJson<T>(value: T): T {
  if (typeof value === "string") return scrubSecrets(value) as unknown as T;
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const next = scrubJson(item);
      if (next !== item) changed = true;
      return next;
    });
    return (changed ? out : value) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const next = scrubJson(item);
      if (next !== item) changed = true;
      out[key] = next;
    }
    return (changed ? out : value) as unknown as T;
  }
  return value;
}
