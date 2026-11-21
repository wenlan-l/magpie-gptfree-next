/**
 * Child processes.
 *
 * Two rules, both learned from Windows:
 *  - never run through a shell (cmd.exe quoting mangles arguments with
 *    spaces, quotes or non-ASCII characters);
 *  - always decode as UTF-8. A Windows console defaults to the OEM code page
 *    (cp936 on Chinese systems), which turns worker JSON into mojibake or a
 *    hard decode error.
 */
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;

export class CommandError extends Error {
  constructor(message, { code, stdout = "", stderr = "", timedOut = false, signal } = {}) {
    super(message);
    this.name = "CommandError";
    this.code = code;
    this.stdout = stdout;
    this.stderr = stderr;
    this.timedOut = timedOut;
    this.signal = signal;
  }
}

/**
 * Run a command to completion and buffer its output as UTF-8 text.
 * Resolves on exit code 0, rejects with CommandError otherwise.
 */
export function runCommand(command, args = [], options = {}) {
  const {
    cwd,
    env = process.env,
    timeout = 60_000,
    input,
    maxBuffer = DEFAULT_MAX_BUFFER,
  } = options;

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      reject(new CommandError(`${command}: ${err.message}`, { code: err.code }));
      return;
    }

    const stdout = [];
    const stderr = [];
    let size = 0;
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeout);

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBuffer) {
        killTree(child);
        finish(reject, new CommandError(`${command}: output exceeded ${maxBuffer} bytes`, { code: "EOVERFLOW" }));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => stderr.push(chunk));

    child.on("error", (err) => {
      finish(reject, new CommandError(`${command}: ${err.message}`, { code: err.code }));
    });

    child.on("close", (code, signal) => {
      const out = Buffer.concat(stdout).toString("utf8");
      const errText = Buffer.concat(stderr).toString("utf8");
      if (timedOut) {
        finish(reject, new CommandError(`${command}: timed out after ${timeout}ms`, {
          code: "ETIMEDOUT", stdout: out, stderr: errText, timedOut: true, signal,
        }));
        return;
      }
      if (code !== 0) {
        finish(reject, new CommandError(`${command} exited with code ${code}`, {
          code: `EXIT_${code}`, stdout: out, stderr: errText, signal,
        }));
        return;
      }
      finish(resolve, { stdout: out, stderr: errText, code });
    });

    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/**
 * Terminate a child and, on Windows, everything it spawned. Node's
 * child.kill() only signals the direct child there, so a Python worker that
 * started a helper survives and keeps the port/file handle alive.
 */
export function killTree(child, { gracefulMs = 1500 } = {}) {
  if (!child || child.exitCode !== null || !child.pid) return;

  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.on("error", () => {});
    return;
  }

  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }
  const hard = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }, gracefulMs);
  hard.unref?.();
}

/**
 * Terminate a process we did not spawn (the previous plugin host's sidecar).
 * Deliberately separate from killTree: there is no child handle to await, and
 * on POSIX we cannot signal a process group we do not own reliably.
 */
export async function killPid(pid, { gracefulMs = 1500, platform = process.platform } = {}) {
  const n = Number(pid);
  if (!Number.isSafeInteger(n) || n <= 0) return false;

  if (platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(n), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.on("error", resolve);
      killer.on("close", resolve);
    });
    return true;
  }

  try {
    process.kill(n, "SIGTERM");
  } catch {
    return false;
  }
  const deadline = Date.now() + gracefulMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    try {
      process.kill(n, 0);
    } catch {
      return true;
    }
  }
  try {
    process.kill(n, "SIGKILL");
  } catch {
    /* raced with exit */
  }
  return true;
}

/**
 * Stream a child's stdout line by line, decoding UTF-8 across chunk
 * boundaries.
 *
 * `runCommand` buffers everything, which is wrong for the streaming text
 * worker: the caller forwards deltas to the user while the request is still
 * running. A plain `chunk.toString("utf8")` (what upstream did) corrupts any
 * multi-byte character that straddles a chunk boundary — Chinese replies
 * arrived as replacement characters.
 *
 * Never rejects for a child that ran and failed: the caller decides what a
 * non-zero exit, a timeout or an abort means.
 */
export function streamCommand(command, args = [], options = {}) {
  const {
    cwd,
    env = process.env,
    timeout = 0,
    input,
    signal,
    onLine,
    maxBuffer = DEFAULT_MAX_BUFFER,
    maxStderr = 16 * 1024,
  } = options;

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({ spawnError: err, code: null, signal: null, stdout: "", stderr: "", timedOut: false, aborted: false });
      return;
    }

    const outDecoder = new StringDecoder("utf8");
    const errDecoder = new StringDecoder("utf8");
    const stdout = [];
    const stderr = [];
    let pending = "";
    let size = 0;
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let overflowed = false;

    const emitLine = (line) => {
      if (!line.trim()) return;
      try {
        onLine?.(line);
      } catch {
        /* a bad listener must not take down the worker */
      }
    };

    const onData = (chunk) => {
      size += chunk.length;
      if (size > maxBuffer) {
        // Keep consuming so the pipe never blocks, but stop accumulating: the
        // caller reports the overflow instead of parsing a truncated document.
        overflowed = true;
        return;
      }
      stdout.push(chunk);
      pending += outDecoder.write(chunk);
      let idx = pending.indexOf("\n");
      while (idx !== -1) {
        const line = pending.slice(0, idx).replace(/\r$/, "");
        pending = pending.slice(idx + 1);
        emitLine(line);
        idx = pending.indexOf("\n");
      }
    };

    const timer = timeout > 0
      ? setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, timeout)
      : null;
    timer?.unref?.();

    const onAbort = () => {
      aborted = true;
      killTree(child);
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      resolve(value);
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", (chunk) => {
      if (stderr.length < maxStderr) stderr.push(chunk);
    });

    child.on("error", (err) => {
      finish({
        spawnError: err,
        code: null,
        signal: null,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
        aborted,
        overflowed,
      });
    });

    child.on("close", (code, sig) => {
      const flushedOut = outDecoder.end();
      const flushedErr = errDecoder.end();
      pending += flushedOut;
      const tail = pending.replace(/\r$/, "");
      pending = "";
      if (tail.trim()) emitLine(tail);
      finish({
        code,
        signal: sig,
        stdout: Buffer.concat(stdout).toString("utf8") + flushedOut,
        stderr: Buffer.concat(stderr).toString("utf8") + flushedErr,
        timedOut,
        aborted,
        overflowed,
      });
    });

    child.stdin.on("error", () => {});
    child.stdin.end(input === undefined ? "" : input, "utf8");
  });
}
