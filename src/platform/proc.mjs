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
