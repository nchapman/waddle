/**
 * Boot-time playpen enforcement (slice 2): the ownership choreography that
 * turns the policy's uid map into kernel boundary. The gateway is root and
 * runs with umask 077, so everything it creates is root-only by default;
 * this module hands the agent its workspace, hands Chromium its profile
 * and HOME, makes tmp a sticky shared scratch, and re-tightens the system
 * tree after restores (tar restores whatever the archive carried — an old
 * or hostile archive must never widen the playpen).
 *
 * Idempotent and cheap enough to run at boot and after every restore.
 * On a dev host (unprivileged) it degrades honestly: the report says so,
 * scrubbing/redaction are unaffected, and /health surfaces the gap.
 */
import { chmodSync, chownSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { AGENT_UID, BROWSER_PATHS, BROWSER_UID, DATA_DIR, SYSTEM_PATHS, playpenActive } from "./policy.js";

export interface PlaypenReport {
  enforced: boolean;
  reason?: string;
  agentUid: number;
  browserUid: number;
  at: string;
}

// The report is never null: a fresh process that hasn't run its boot-time
// enforcement yet answers honestly with the sentinel below (keeps /health's
// shape stable for the client).
let lastReport: PlaypenReport = {
  enforced: false,
  reason: "not yet enforced (boot has not run)",
  agentUid: AGENT_UID,
  browserUid: BROWSER_UID,
  at: new Date(0).toISOString(),
};

/** The latest enforcement result (null before the first run). */
export function playpenReport(): PlaypenReport {
  return lastReport;
}

/** Apply the playpen to DATA_DIR. Testable entry point takes explicit
 *  uids so unprivileged hosts can exercise the mechanics chown-to-self
 *  (the system tree defaults to root; only root can actually do that). */
export function enforcePlaypenInto(
  dir: string,
  agentUid: number,
  browserUid: number,
  systemUid = 0,
): PlaypenReport {
  const problems: string[] = [];
  const note = (label: string, err: unknown) => {
    if (problems.length < 8) {
      problems.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  // Per-entry isolation: one hostile archive member (a dangling symlink,
  // an unreadable tree) must never skip the enforcement of the rest
  // (review-caught: a single throw used to abort the whole choreography).
  const step = (label: string, fn: () => void) => {
    try {
      fn();
    } catch (err) {
      note(label, err);
    }
  };
  try {
    mkdirSync(dir, { recursive: true });
    // The volume shape: DATA root is system-uid-owned and traversable
    // (0755) — the entries under it carry the boundary. An accidental
    // 0700 here (e.g. a scratch dir) would starve the child uids of every
    // absolute path under it.
    step("data-root", () => {
      chmodSync(dir, 0o755);
      chownSync(dir, systemUid, systemUid);
    });
    // Chromium's XDG dirs are created HERE, not lazily at browser boot:
    // a lazy mkdir would run as root under the 077 umask and hand the
    // browser uid unwritable dirs (review-caught). They must exist before
    // the recursive chown below walks the tree. A symlinked home gets no
    // XDG creation — mkdirSync would follow the link and write outside
    // DATA_DIR (review-caught); ensureOwned refuses and notes the link.
    step("home-xdg", () => {
      if (isSymlink(join(dir, "home"))) return;
      mkdirSync(join(dir, "home", ".config"), { recursive: true });
      mkdirSync(join(dir, "home", ".cache"), { recursive: true });
    });
    // The agent's root: owned by the bash uid, agent-private.
    step("workspace", () => ensureOwned(join(dir, "workspace"), agentUid, 0o700, note));
    // Chromium's own: the profile (cookies = bearer tokens) and its HOME —
    // browser-uid-owned, NOT part of the root-owned system tree (the
    // container check caught exactly this mix-up: the system tighten loop
    // chowned the profile back to root and Chromium could not write it).
    for (const p of BROWSER_PATHS) step(p, () => ensureOwned(join(dir, p), browserUid, 0o700, note));
    // Shared scratch: bash TMPDIR, browser TMPDIR, restore slots, pi's
    // bash-output spools (those are root 0600 under the umask — the agent
    // cannot read them back). Sticky like any /tmp.
    step("tmp", () => ensureTmp(join(dir, "tmp")));
    // The system tree: system-uid-only, no group/other bits, regardless
    // of what a restored archive carried.
    for (const p of SYSTEM_PATHS) step(p, () => tightenSystemTree(join(dir, p), systemUid, note));
  } catch (err) {
    note("playpen", err);
  }
  lastReport = {
    enforced: problems.length === 0,
    ...(problems.length > 0 ? { reason: problems.join("; ") } : {}),
    agentUid,
    browserUid,
    at: new Date().toISOString(),
  };
  return lastReport;
}

/** Enforce with the production uids; honest no-op when unprivileged. */
export function enforcePlaypen(): PlaypenReport {
  if (!playpenActive()) {
    lastReport = {
      enforced: false,
      reason: "not running as root (dev host) — env scrub and redaction active, no kernel boundary",
      agentUid: AGENT_UID,
      browserUid: BROWSER_UID,
      at: new Date().toISOString(),
    };
    return lastReport;
  }
  return enforcePlaypenInto(DATA_DIR, AGENT_UID, BROWSER_UID);
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** mkdir -p + mode + chown the tree (recursively: restores land as root).
 *  A symlinked top is REFUSED, never followed — chmod/chown both follow
 *  links, and a restored `browser -> /etc` entry must not re-mode /etc
 *  (review-caught). Chown failures are NOTED, not fatal — the shape still
 *  applies and the report says what is missing. Interior modes are the
 *  owner's business — only the top dir's mode is set. */
function ensureOwned(path: string, uid: number, dirMode: number, note: (label: string, err: unknown) => void): void {
  const refuseSymlink = () => note(path, new Error("refusing: playpen entry is a symlink"));
  try {
    mkdirSync(path, { recursive: true });
  } catch (err) {
    // mkdir throws EEXIST on a symlink-to-file; refuse it as a symlink
    // rather than surfacing a confusing EEXIST.
    if (isSymlink(path)) {
      refuseSymlink();
      return;
    }
    throw err;
  }
  if (isSymlink(path)) {
    // A symlink-to-dir passes mkdir silently — refuse before chmod follows it.
    refuseSymlink();
    return;
  }
  chmodSync(path, dirMode);
  try {
    chownTree(path, uid);
  } catch (err) {
    note(path, err);
  }
}

function ensureTmp(path: string): void {
  try {
    mkdirSync(path, { recursive: true });
  } catch (err) {
    if (isSymlink(path)) throw new Error("refusing: tmp is a symlink");
    throw err;
  }
  if (isSymlink(path)) throw new Error("refusing: tmp is a symlink");
  chmodSync(path, 0o1777); // sticky: shared scratch, nobody deletes others' files
}

/** System-uid-only, no group/other bits — the sealed log, verifier,
 *  sessions, schedules, preferences, pi config, and the dev wake
 *  credential. Mode first (the kernel boundary half that always applies),
 *  then ownership, noting failures without aborting the walk. A symlinked
 *  entry is REFUSED AND SURFACED — silently skipping it would let a
 *  hostile archive point "the log" into the agent's tree while the report
 *  still says enforced (review-caught). */
function tightenSystemTree(path: string, uid: number, note: (label: string, err: unknown) => void): void {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      note(path, new Error("refusing: system entry is a symlink"));
      return;
    }
    walk(
      path,
      (entry, isDir) => {
        chmodSync(entry, isDir ? 0o700 : 0o600);
        try {
          chownSync(entry, uid, uid);
        } catch (err) {
          note(entry, err);
        }
      },
      // An INTERIOR symlink (log/events.jsonl -> workspace/…) is neither
      // tightened nor silently skipped: the gateway would append the sealed
      // log through it into the agent's tree while the report still said
      // enforced (review-caught).
      (entry) => note(entry, new Error("refusing: system entry is a symlink")),
    );
  } catch (err) {
    // A missing system entry is normal (created lazily by its owner, with
    // the umask); anything else is worth surfacing.
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code !== "ENOENT") note(path, err);
  }
}

/** Recursive chown. Symlinks are skipped, never followed: chown(2) would
 *  operate on the target, and a planted link must not re-own the system
 *  tree (the kernel already blocks the agent reading through one). */
function chownTree(path: string, uid: number): void {
  walk(path, (entry) => chownSync(entry, uid, uid));
}

/** Depth-first walk; the visitor sees dirs and files, never symlink
 *  targets. Missing roots are the caller's business (ENOENT propagates). */
function walk(
  root: string,
  visit: (entry: string, isDir: boolean) => void,
  onSymlink?: (entry: string) => void,
): void {
  const st = lstatSync(root);
  if (st.isSymbolicLink()) {
    // Never follow (chmod/chown through a link hands over its target) —
    // but the caller decides whether a link it can't tighten is worth
    // surfacing: the system tree treats one as a refusal, the agent's
    // own tree legitimately contains the agent's own links.
    onSymlink?.(root);
    return;
  }
  const isDir = st.isDirectory();
  if (isDir) {
    for (const name of readdirSync(root)) {
      walk(join(root, name), visit, onSymlink);
    }
  }
  visit(root, isDir);
}
