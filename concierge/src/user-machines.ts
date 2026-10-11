/**
 * @waddle/concierge — the user→machine registry (the cattle spine).
 *
 * Every user (a betterbase `sub`) gets machines named
 * `waddle-u<hash6>-<rand6>`: the hash encodes the user (so a concierge
 * reboot can REBIND from the platform list without a persisted map —
 * one-way, no PII in the name), the rand makes every mint fresh (a new
 * name has no negative-cache history anywhere — the DNS class dies at
 * the root). The registry holds no secrets and no user data — names,
 * only. Memory-only like everything concierge-side; the platform list
 * is the durable truth it rebuilds from.
 */
import { createHash, randomBytes } from "node:crypto";

/** `waddle-u<hex8>-<lower-alnum6>` — anchored, exact. The 8-hex user
 *  fragment (32 bits) keeps two-user aliasing at ~1/4·10⁹ per pair; the
 *  consequence of an alias is one blank machine handed to the wrong
 *  user (their secret still gates everything) — k=1 acceptable. */
export function userNameRe(): RegExp {
  return /^waddle-u[0-9a-f]{8}-[0-9a-z]{6}$/;
}

/** The user's stable fragment inside their machine names. */
export function hashSub(sub: string): string {
  return createHash("sha256").update(sub).digest("hex").slice(0, 8);
}

function rand6(): string {
  return randomBytes(4).toString("hex").slice(0, 6);
}

export interface UserMachines {
  /** Retire a name permanently (this process): the platform scan must
   *  not resurrect it via adopt — a fresh-mint retire is exactly the
   *  "browser cache holds this name dead" case. Memory-only; after a
   *  concierge restart the map (which points at the NEW machine)
   *  dominates rebind, so a resurrected old name is at worst a second
   *  restart away — k=1 residue, documented. */
  retire(name: string): void;
  /** The user's current machine, minted if none is bound. Records the
   *  name in the known-set (the namespace authority for
   *  allowedInstance/sweep) even on a rebind of an adopted name. */
  bind(sub: string): string;
  /** After a concierge reboot the map is empty — find the user's
   *  machine among KNOWN names by its embedded hash. Null when the
   *  user has no machine alive (caller mints via bind). */
  rebind(sub: string): string | null;
  /** Claim an existing name (e.g. a warm standby) as a user's machine. */
  claim(sub: string, name: string): void;
  /** Names seen on the platform / minted here — the authorization set. */
  known(): Set<string>;
  /** Live bindings (map values) — sleepers with an active owner. */
  boundNames(): Set<string>;
  /** When the scan adopted this name (0 when never) — the inheritance
   *  clock for post-restart sleepers the sweep eventually destroys. */
  adoptedAt(name: string): number;
  /** Refill the known-set from a platform scan (idempotent). */
  adopt(names: Iterable<string>): number;
  /** A machine is gone (destroyed/reaped) — drop it from the map. */
  forget(name: string): void;
}

export function createUserMachines(): UserMachines {
  const map = new Map<string, string>(); // sub -> current machine name
  const known = new Set<string>();
  const retired = new Set<string>();
  /** name -> when the scan adopted it (ms). A sleeper the concierge
   *  INHERITED (post-restart, no table entry) ages on this clock — the
   *  sweep destroys it after HARD_STOP_MS of nobody re-binding it. */
  const adoptedAt = new Map<string, number>();
  const re = userNameRe();
  return {
    retire(name: string): void {
      adoptedAt.delete(name);
      retired.add(name);
      known.delete(name);
      for (const [sub, n] of map) if (n === name) map.delete(sub);
    },
    bind(sub: string): string {
      const existing = map.get(sub);
      if (existing && known.has(existing)) return existing;
      const prefix = `waddle-u${hashSub(sub)}-`;
      let name = existing; // stale-but-known? mint fresh; names are cattle
      do {
        name = `${prefix}${rand6()}`;
      } while (known.has(name) || retired.has(name));
      map.set(sub, name);
      known.add(name);
      return name;
    },
    rebind(sub: string): string | null {
      // The MAP first: a claimed machine (a standby name) carries no hash
      // — without this, every /boot after a warm claim hands the user a
      // DIFFERENT standby and orphans the old one (review-caught).
      const bound = map.get(sub);
      if (bound && known.has(bound)) return bound;
      const prefix = `waddle-u${hashSub(sub)}-`;
      for (const n of known) if (n.startsWith(prefix)) return n; // ≤ handful: linear is honest
      return null;
    },
    claim(sub: string, name: string): void {
      map.set(sub, name);
      known.add(name);
      adoptedAt.delete(name); // claimed = owned; no inheritance clock
    },
    known(): Set<string> {
      return known;
    },
    /** Live bindings (map values) — sleeping machines with an active
     *  owner; distinct from known(), which also holds adopted unbound
     *  sleepers the sweep may eventually destroy. */
    boundNames(): Set<string> {
      return new Set(map.values());
    },
    /** When the scan adopted this name (0 when never). */
    adoptedAt(name: string): number {
      return adoptedAt.get(name) ?? 0;
    },
    adopt(names: Iterable<string>): number {
      let n = 0;
      for (const name of names) {
        if (re.test(name) && !known.has(name) && !retired.has(name)) {
          known.add(name);
          adoptedAt.set(name, Date.now());
          n++;
        }
      }
      return n;
    },
    forget(name: string): void {
      adoptedAt.delete(name);
      known.delete(name);
      for (const [sub, n] of map) if (n === name) map.delete(sub);
    },
  };
}
