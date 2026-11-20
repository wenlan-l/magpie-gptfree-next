/**
 * Python discovery and virtual-environment management.
 *
 * The plugin needs a real CPython 3.8+ with pip, because the workers depend on
 * curl_cffi and requests. Windows makes "find a python" genuinely hard:
 *
 *  - `python` may be the Microsoft Store alias stub, which prints "Python was
 *    not found" and exits 9009 instead of running anything;
 *  - the launcher is usually `py -3`, not `python3`;
 *  - the venv interpreter lives in Scripts\python.exe, not bin/python.
 *
 * So every candidate is *probed*, never trusted by name.
 */
import { access } from "node:fs/promises";
import { join } from "node:path";
import { CommandError, runCommand } from "./proc.mjs";

const PROBE = [
  "import json,sys",
  "print(json.dumps({'major':sys.version_info[0],'minor':sys.version_info[1],",
  "'micro':sys.version_info[2],'executable':sys.executable,'prefix':sys.prefix}))",
].join(";");

export class PythonNotFoundError extends Error {
  constructor(attempts) {
    const detail = attempts
      .map((a) => `  ${a.command} ${a.args.join(" ")} → ${a.error}`.trimEnd())
      .join("\n");
    super(`未找到可用的 Python 3.8+\n${detail}`);
    this.name = "PythonNotFoundError";
    this.attempts = attempts;
  }
}

export function venvDir(home) {
  return join(home, "python-venv");
}

export function venvPython(home, platform = process.platform) {
  return platform === "win32"
    ? join(venvDir(home), "Scripts", "python.exe")
    : join(venvDir(home), "bin", "python");
}

/** Ordered candidates. Pure function so tests can assert the order per OS. */
export function pythonCandidates({ env = process.env, home = pluginHome(env), platform = process.platform } = {}) {
  const list = [];
  const override = typeof env.MAGPIE_GPTFREE_PYTHON === "string" ? env.MAGPIE_GPTFREE_PYTHON.trim() : "";
  if (override) list.push({ command: override, args: [] });
  if (home) list.push({ command: venvPython(home, platform), args: [] });
  if (platform === "win32") {
    list.push({ command: "py", args: ["-3"] });
    list.push({ command: "python3", args: [] });
    list.push({ command: "python", args: [] });
  } else {
    list.push({ command: "python3", args: [] });
    list.push({ command: "python", args: [] });
  }
  return list;
}

function parseProbe(stdout) {
  const line = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .pop();
  if (!line) throw new Error("probe produced no JSON");
  const info = JSON.parse(line);
  if (!Number.isInteger(info.major) || info.major !== 3 || !Number.isInteger(info.minor) || info.minor < 8) {
    throw new Error(`unsupported version ${info.major}.${info.minor}`);
  }
  return info;
}

export async function probePython(candidate, { run = runCommand, timeout = 15_000 } = {}) {
  try {
    const { stdout } = await run(candidate.command, [...candidate.args, "-c", PROBE], {
      timeout,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
    });
    return parseProbe(stdout);
  } catch (err) {
    if (err instanceof CommandError && /9009|Python was not found|not recognized/i.test(err.stderr + err.message)) {
      throw new Error("Microsoft Store 占位程序，不是真实 Python");
    }
    throw err;
  }
}

/**
 * First candidate that probes successfully. `attempts` is returned for
 * diagnostics even on success, so a report can show what was skipped and why.
 */
export async function resolvePython({ env = process.env, home = pluginHome(env), run = runCommand } = {}) {
  const attempts = [];
  for (const candidate of pythonCandidates({ env, home })) {
    try {
      await access(candidate.command).catch(() => {});
      const info = await probePython(candidate, { run });
      return { ...candidate, info, attempts };
    } catch (err) {
      attempts.push({ ...candidate, error: err.message });
    }
  }
  throw new PythonNotFoundError(attempts);
}

export async function ensureVenv({ home = pluginHome(), env = process.env, run = runCommand, log } = {}) {
  const target = venvPython(home);
  try {
    const info = await probePython({ command: target, args: [] }, { run });
    return { python: target, created: false, info };
  } catch {
    /* fall through and create it */
  }

  const base = await resolvePython({ env, home, run });
  log?.info?.("creating python venv", { dir: venvDir(home), using: base.command });
  await run(base.command, [...base.args, "-m", "venv", venvDir(home)], { timeout: 180_000 });
  const info = await probePython({ command: target, args: [] }, { run });
  return { python: target, created: true, info };
}

export async function installRequirements({
  home = pluginHome(),
  env = process.env,
  requirements,
  run = runCommand,
  log,
} = {}) {
  const python = venvPython(home);
  const args = ["-m", "pip", "install", "--disable-pip-version-check", "--no-input"];
  const index = typeof env.MAGPIE_GPTFREE_PIP_INDEX === "string" ? env.MAGPIE_GPTFREE_PIP_INDEX.trim() : "";
  if (index) args.push("--index-url", index);
  args.push("-r", requirements);
  log?.info?.("installing python requirements", { requirements, index: index || "default" });
  await run(python, args, { timeout: 900_000 });
}
