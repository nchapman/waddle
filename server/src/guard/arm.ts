/**
 * Arm hygiene (slice 4): the checks between "this machine wants to escrow
 * its state for unattended work" and the escrow leaving it. Two verdicts,
 * two severities:
 *
 *  - PLAYPEN — a machine whose kernel boundary failed to enforce never
 *    hands its secrets to the concierge. The playpen report the restore
 *    path deliberately surfaces (instead of failing the restore over) is
 *    consumed HERE: the arm refusal is the point of surfacing it. Dev
 *    hosts never claimed a boundary (not root — /health says so) and
 *    always pass; only a machine that should have enforced and didn't is
 *    refused.
 *
 *  - SNAPSHOT — the context snapshot riding the escrow must carry
 *    context, not credentials: no browser profile (cookies are bearer
 *    tokens) and no registered secret in plaintext (a workspace file or
 *    transcript must never ship the concierge secret out with the
 *    delegation). A dirty snapshot degrades to a context-free arm — the
 *    run still fires, the dirty bytes stay home. Verified, not assumed:
 *    the browser exclusion lives in createArchive(true) by convention;
 *    this reads the actual tar that was about to be sealed.
 */
import { decodeArchive } from "../archive.js";
import { playpenReport, type PlaypenReport } from "./playpen.js";
import { playpenActive, registeredSecrets } from "./policy.js";

export type HygieneVerdict = { ok: true } | { ok: false; reason: string };

/** The playpen side of the gate. Pure over its inputs so the root/dev
 *  branches are testable without privileges. */
export function playpenGate(active: boolean, report: PlaypenReport): HygieneVerdict {
  if (!active) return { ok: true }; // dev host: no boundary was ever claimed
  if (!report.enforced) return { ok: false, reason: report.reason ?? "playpen not enforced" };
  return { ok: true };
}

/** The live check the sleep gate runs before writing wake rows or escrow. */
export function checkPlaypenForArm(): HygieneVerdict {
  return playpenGate(playpenActive(), playpenReport());
}

/** One tar member: its (normalized) name and its content's byte range in
 *  the decoded tar — the range maps a secret hit back to the file that
 *  carries it, so the refusal names the cleanup target. */
interface TarMember {
  name: string;
  start: number;
  end: number;
}

const cstr = (buf: Buffer, off: number, len: number): string =>
  buf.subarray(off, off + len).toString("utf8").split("\0")[0] ?? "";

/** Walk ustar/GNU/pax tar headers without spawning anything. Handles GNU
 *  long-name ('L') members and ustar prefixes; pax extended headers
 *  ('x'/'g') carry no member of their own (their content is still scanned
 *  — the whole-buffer secret search covers it). Leading "./" (tar -C dir .)
 *  is stripped so member names compare against DATA_DIR-relative paths.
 * Exported for tests — the container's GNU tar and macOS bsdtar produce
 *  different header dialects, and both shapes must walk. */
export function walkTar(tar: Buffer): TarMember[] {
  const members: TarMember[] = [];
  let pos = 0;
  let longName: string | null = null;
  while (pos + 512 <= tar.length) {
    const header = tar.subarray(pos, pos + 512);
    if (header.every((b) => b === 0)) break; // end-of-archive zero block
    const rawName = cstr(header, 0, 100);
    const prefix = cstr(header, 345, 155); // ustar: name is prefix + "/" + name
    const size = parseInt(cstr(header, 124, 12).trim() || "0", 8) || 0;
    const type = String.fromCharCode(header[156] ?? 0);
    const start = pos + 512;
    const end = start + size;
    if (type === "L") {
      // GNU long name: this member's content is the NEXT member's name.
      longName = cstr(tar.subarray(start, end), 0, size);
    } else if (type !== "x" && type !== "g") {
      const name = (longName ?? (prefix ? `${prefix}/${rawName}` : rawName)).replace(/^\.\//, "");
      members.push({ name, start, end });
      longName = null;
    }
    // The data block occupies ceil(size/512) blocks AFTER the 512-byte
    // header; the next header starts there (padding, not size, separates).
    pos = start + Math.ceil(size / 512) * 512;
  }
  return members;
}

/**
 * The snapshot side of the gate, run on the unsealed archive body the
 * sleep gate is about to seal. Throws on an undecodable body — the
 * caller's existing catch degrades that to a context-free arm.
 *
 * `extraSecrets` covers arm-time values the registry may not hold (e.g.
 * the dev arm's inference key when it differs from the platform env).
 */
export function checkSnapshotHygiene(
  body: Buffer,
  extraSecrets: ReadonlyArray<[name: string, value: string]> = [],
): HygieneVerdict {
  const tar = decodeArchive(body);
  const members = walkTar(tar);
  for (const m of members) {
    if (m.name === "browser" || m.name.startsWith("browser/")) {
      return { ok: false, reason: `browser profile in snapshot: ${m.name}` };
    }
  }
  // Scan the whole decoded buffer — file contents, member names, and pax
  // extended records alike. A hit maps back to the owning member so the
  // refusal names the file to clean up (never the secret itself).
  for (const [name, value] of [...registeredSecrets(), ...extraSecrets]) {
    const idx = tar.indexOf(value);
    if (idx !== -1) {
      const owner = members.find((m) => idx >= m.start && idx < m.end);
      const where = owner ? `at ${owner.name}` : "in a tar path/header";
      return { ok: false, reason: `registered secret "${name}" in snapshot ${where}` };
    }
  }
  return { ok: true };
}
