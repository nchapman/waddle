/**
 * The waddle guard extension — pi-core behavior changes ride the extension
 * seam, never ad-hoc tool surgery:
 *
 *   1. `write`/`edit` are re-registered with operations that hand created
 *      files to the agent uid and refuse symlink escapes: the tools execute
 *      in-process as root, so without this a tool-written workspace file
 *      would be root-only and any lexically-in-workspace path could point
 *      anywhere (realpath containment, hiro's confineTo lesson).
 *   2. A `tool_result` handler redacts registered secrets from every
 *      tool's output at the transcript boundary (content and
 *      structuredContent together — replacing one drops the other).
 *
 * There is no `bash` (and no `run`): the agent has no shell and no program
 * execution at all. Arbitrary agent code runs only inside codemode's
 * QuickJS sandbox, which has no fs/network/Node APIs and reaches the world
 * exclusively through gated tools — so the whole "parse the command line"
 * problem class (hiro's extractCommands, tripwire regexes over shell text,
 * safety-model argv classification) does not exist here.
 */
import { constants as fsConstants } from "node:fs";
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { access as fsAccess, mkdir as fsMkdir, open as fsOpen, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  createEditToolDefinition,
  createWriteToolDefinition,
  type EditOperations,
  type ExtensionAPI,
  type InlineExtension,
  type ToolResultEvent,
  type ToolResultEventResult,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { AGENT_UID, WORKSPACE, playpenActive } from "./policy.js";
import { containsSecret, scrubJson, scrubSecrets } from "./redact.js";

/** The components to hand over (pure, testable): the workspace root plus
 *  every segment of the path — stopping at a symlink (the workspace root
 *  itself must be a real dir, or there is no handoff at all). chown(2)
 *  follows links, and an agent-planted `workspace/link -> /data/browser`
 *  must not hand the link's target to the agent uid (review-caught — the
 *  playpen walker has the same no-follow rule). */
export function handoffComponents(absolutePath: string, workspace: string = WORKSPACE): string[] {
  try {
    if (lstatSync(workspace).isSymbolicLink()) return [];
  } catch {
    return [];
  }
  const full = resolve(workspace, absolutePath);
  if (full !== workspace && !full.startsWith(`${workspace}/`)) return [];
  const rel = relative(workspace, full);
  const out = [workspace];
  let cur = workspace;
  for (const seg of rel.split("/")) {
    if (!seg) continue;
    cur = join(cur, seg);
    try {
      if (lstatSync(cur).isSymbolicLink()) break;
    } catch {
      break;
    }
    out.push(cur);
  }
  return out;
}

/** Hand a path (and every component under the workspace root) to the agent
 *  uid. The component list bounds the walk; the handoff itself is
 *  fd-pinned — O_NOFOLLOW open then fchown(fd) — so an agent racing a
 *  component swap (check-then-chown TOCTOU, review-caught) can only make
 *  the open fail or pin the pre-swap inode, never chown through a link. */
export async function ownForAgent(absolutePath: string): Promise<void> {
  if (!playpenActive()) return;
  for (const p of handoffComponents(absolutePath)) {
    const isDir = (() => {
      try {
        return lstatSync(p).isDirectory();
      } catch {
        return false;
      }
    })();
    const flags =
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | (isDir ? fsConstants.O_DIRECTORY : 0);
    const fh = await fsOpen(p, flags).catch(() => null);
    if (fh === null) return; // vanished or swapped for a link: stop the handoff here
    try {
      await fh.chown(AGENT_UID, AGENT_UID);
    } catch {
      /* a component we cannot re-own is noted by the playpen, not fatal */
    } finally {
      await fh.close().catch(() => undefined);
    }
  }
}

/** Resolve the deepest existing ancestor's real path, keeping the
 *  missing tail lexically (mkdir creates the tail as real dirs; the
 *  symlink risk lives in the existing part, which realpath checks).
 *  A DANGLING symlink also ENOENTs realpath — but lstat sees it — so a
 *  symlink is never lexicalized into the tail: its readlink target is
 *  resolved and contained instead (a write would land there, review-caught). */
function realPathOrNearest(p: string): { real: string; missing: string[] } {
  try {
    return { real: realpathSync(p), missing: [] };
  } catch {
    let isLink = false;
    try {
      isLink = lstatSync(p).isSymbolicLink();
    } catch {
      /* genuinely missing: walk up */
    }
    if (isLink) return realPathOrNearest(resolve(dirname(p), readlinkSync(p)));
    const parent = dirname(p);
    if (parent === p) return { real: p, missing: [] };
    const { real, missing } = realPathOrNearest(parent);
    return { real, missing: [basename(p), ...missing] };
  }
}

/** Realpath containment for the file tools (hiro's confineTo lesson): the
 *  tools execute in-process as root, and a workspace symlink is the one way
 *  their lexical containment lies — `write(path: "link/x")` with
 *  `link -> /data/log` writes into the system tree as root, invisible to
 *  the tripwire's lexical checks and to the kernel's uid boundary (which
 *  only bounds the shell). Resolve what the path REALLY is (following
 *  links, dangling included) and refuse what lands outside the workspace.
 *  Residual: a microsecond swap race between check and write — that is
 *  deliberate intent by definition, and fd-pinned writes are the parked
 *  hardening. */
export function assertWorkspaceContained(absolutePath: string, workspace: string = WORKSPACE): void {
  // The workspace root itself must be a real directory: a symlinked root
  // would make every containment check pass against the link's target
  // (review-caught — the ownership handoff refuses the same shape).
  if (lstatSync(workspace).isSymbolicLink()) {
    throw new Error("access denied: the workspace root itself is a symlink");
  }
  const resolved = resolve(workspace, absolutePath);
  const { real, missing } = realPathOrNearest(resolved);
  const full = join(real, ...missing);
  const realWorkspace = realpathSync(workspace);
  if (full !== realWorkspace && !full.startsWith(`${realWorkspace}/`)) {
    throw new Error(`access denied: ${absolutePath} resolves outside the workspace (symlink escape) — the system tree is not yours to write`);
  }
}

/** Mirrors pi's defaultWriteOperations, plus agent ownership and symlink
 *  containment. Exported for the container-level verification script. */
export function agentOwnedWriteOperations(): WriteOperations {
  return {
    writeFile: async (path, content) => {
      assertWorkspaceContained(path);
      await fsWriteFile(path, content, "utf-8");
      await ownForAgent(path);
    },
    mkdir: async (dir) => {
      assertWorkspaceContained(dir);
      await fsMkdir(dir, { recursive: true });
      await ownForAgent(dir);
    },
  };
}

/** Mirrors pi's defaultEditOperations, plus agent ownership and symlink
 *  containment on writes (reads need nothing: the gateway is root, or dev
 *  is the same uid — read scope is slice 3's policy question). */
export function agentOwnedEditOperations(): EditOperations {
  return {
    readFile: (path) => fsReadFile(path),
    access: (path) => fsAccess(path, fsConstants.R_OK | fsConstants.W_OK),
    writeFile: async (path, content) => {
      assertWorkspaceContained(path);
      await fsWriteFile(path, content, "utf-8");
      await ownForAgent(path);
    },
  };
}

/**
 * Redact secrets from a finished tool result. Returns undefined when
 * nothing matched (a clean no-op for the handler chain).
 */
export function redactToolResult(event: ToolResultEvent): ToolResultEventResult | undefined {
  let contentChanged = false;
  const content = event.content.map((part) => {
    if (part.type === "text" && containsSecret(part.text)) {
      contentChanged = true;
      return { ...part, text: scrubSecrets(part.text) };
    }
    return part;
  });

  const structured = event.structuredContent;
  let structuredChanged = false;
  let structuredOut = structured;
  if (structured !== undefined) {
    const next = scrubJson(structured);
    if (next !== structured) {
      structuredChanged = true;
      structuredOut = next;
    }
  }

  if (!contentChanged && !structuredChanged) return undefined;
  return {
    content: contentChanged ? content : event.content,
    // Pairing rule: replacing content drops structuredContent unless it is
    // returned too — scrubbed if it changed, the original if it did not.
    ...(structuredOut !== undefined ? { structuredContent: structuredOut } : {}),
  };
}

/** The guard extension: guarded tools + transcript-boundary redaction. */
export function createGuardExtension(workspace: string): InlineExtension {
  return {
    name: "waddle-guard",
    factory: (pi: ExtensionAPI) => {
      pi.registerTool(createWriteToolDefinition(workspace, { operations: agentOwnedWriteOperations() }));
      pi.registerTool(createEditToolDefinition(workspace, { operations: agentOwnedEditOperations() }));
      pi.on("tool_result", redactToolResult);
    },
  };
}
