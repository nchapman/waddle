/**
 * Local shell execution as an unprivileged uid — a faithful port of pi's
 * createLocalShellOperations (same shell resolution via getShellConfig,
 * same detached-process-group kill semantics on timeout/abort, same
 * waitForChildProcess idle-grace tail handling — earendil-works/pi#5303)
 * plus uid/gid on the spawn, the one thing pi's built-in operations
 * cannot do. This is the kernel seam of slice 2: everything the shell
 * touches is bounded by the agent uid's file permissions.
 *
 * Detached-pid shutdown tracking is intentionally NOT ported: pi wires
 * killTrackedDetachedChildren only in its CLI modes, never in SDK
 * embedding, so omitting it leaves waddle's behavior unchanged (the
 * container's teardown reaps strays).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { getShellConfig, type BashOperations } from "@earendil-works/pi-coding-agent";
import { scrubEnv } from "./policy.js";

const MAX_TIMEOUT_MS = 2_147_483_647;
const EXIT_STDIO_GRACE_MS = 100;

function resolveTimeoutMs(timeout: number | undefined): number | undefined {
  if (timeout === undefined) return undefined;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error("Invalid timeout: must be a finite number of seconds");
  }
  const timeoutMs = timeout * 1000;
  if (timeoutMs > MAX_TIMEOUT_MS) throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_MS / 1000} seconds`);
  return timeoutMs;
}

/** SIGKILL the process group (detached children made it a group leader),
 *  falling back to the pid alone. Port of pi's killProcessTree, Unix arm. */
export function killProcessTree(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already dead */
    }
  }
}

/**
 * Wait for termination without hanging on stdio handles inherited by
 * detached descendants. After exit we wait for the pipes to fall idle:
 * the grace timer re-arms on every chunk, so an actively writing
 * descendant keeps us reading while a quiet inherited handle still
 * releases us. Port of pi's waitForChildProcess (pi#5303).
 */
export function waitForChildProcess(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let exited = false;
    let exitCode: number | null = null;
    let postExitTimer: ReturnType<typeof setTimeout> | undefined;
    let stdoutEnded = child.stdout === null;
    let stderrEnded = child.stderr === null;

    const cleanup = () => {
      if (postExitTimer) clearTimeout(postExitTimer);
      postExitTimer = undefined;
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      child.stdout?.removeListener("end", onStdoutEnd);
      child.stderr?.removeListener("end", onStderrEnd);
      child.stdout?.removeListener("data", onData);
      child.stderr?.removeListener("data", onData);
    };
    const finalize = (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(code);
    };
    const maybeFinalizeAfterExit = () => {
      if (!exited || settled) return;
      if (stdoutEnded && stderrEnded) finalize(exitCode);
    };
    const armIdleTimer = () => {
      if (postExitTimer) clearTimeout(postExitTimer);
      postExitTimer = setTimeout(() => finalize(exitCode), EXIT_STDIO_GRACE_MS);
    };
    const onData = () => {
      if (exited && !settled) armIdleTimer(); // still writing past exit: keep reading
    };
    const onStdoutEnd = () => {
      stdoutEnded = true;
      maybeFinalizeAfterExit();
    };
    const onStderrEnd = () => {
      stderrEnded = true;
      maybeFinalizeAfterExit();
    };
    const onError = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const onExit = (code: number | null) => {
      exited = true;
      exitCode = code;
      maybeFinalizeAfterExit();
      if (!settled) armIdleTimer();
    };
    const onClose = (code: number | null) => finalize(code);

    child.stdout?.once("end", onStdoutEnd);
    child.stderr?.once("end", onStderrEnd);
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);
  });
}

/** pi's local shell execution, but the child runs as the given uid/gid
 *  (the playpen's agent uid) with the scrubbed env. */
export function uidShellOperations(uid: number, gid: number): BashOperations {
  return {
    exec: async (command, cwd, options) => {
      const timeoutMs = resolveTimeoutMs(options.timeout);
      if (options.signal?.aborted) throw new Error("aborted");
      const shellConfig = getShellConfig();
      try {
        await fsAccess(cwd, fsConstants.F_OK);
      } catch {
        throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
      }
      const commandFromStdin = shellConfig.commandTransport === "stdin";
      const child = spawn(
        shellConfig.shell,
        commandFromStdin ? shellConfig.args : [...shellConfig.args, command],
        {
          cwd,
          detached: process.platform !== "win32",
          uid,
          gid,
          env: scrubEnv(options.env ?? process.env),
          stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
        },
      );
      if (commandFromStdin) {
        child.stdin?.on("error", () => undefined);
        child.stdin?.end(command);
      }
      let timedOut = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => {
        if (child.pid) killProcessTree(child.pid);
      };
      try {
        if (timeoutMs !== undefined) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            if (child.pid) killProcessTree(child.pid);
          }, timeoutMs);
        }
        options.onData && child.stdout?.on("data", options.onData);
        options.onData && child.stderr?.on("data", options.onData);
        if (options.signal) {
          if (options.signal.aborted) onAbort();
          else options.signal.addEventListener("abort", onAbort, { once: true });
        }
        const exitCode = await waitForChildProcess(child);
        if (options.signal?.aborted) throw new Error("aborted");
        if (timedOut) throw new Error(`timeout:${options.timeout}`);
        // A signal-killed shell has no exit code — use the shell convention
        // so callers do not mistake termination for success.
        const signalCode = child.signalCode;
        return { exitCode: exitCode ?? (signalCode ? 128 + (osConstants.signals[signalCode] ?? 0) : 1) };
      } finally {
        if (options.signal) options.signal.removeEventListener("abort", onAbort);
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }
    },
  };
}
