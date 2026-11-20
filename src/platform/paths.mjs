/**
 * Path resolution.
 *
 * This is the ONLY module allowed to know how the operating system lays out
 * directories. Everything above it receives absolute paths.
 */
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const APP_DIR_NAME = ".magpie-gptfree";

/**
 * Persistent plugin state: account vault, stats, venv, session capabilities.
 * Honours MAGPIE_GPTFREE_HOME so a host (or a test) can relocate it.
 */
export function pluginHome(env = process.env) {
  const configured = typeof env.MAGPIE_GPTFREE_HOME === "string"
    ? env.MAGPIE_GPTFREE_HOME.trim()
    : "";
  return resolve(configured || join(homedir(), APP_DIR_NAME));
}

export async function ensureDir(dir, mode = 0o700) {
  await mkdir(dir, { recursive: true, mode });
  return dir;
}

/**
 * Windows refuses paths longer than ~260 characters unless they carry the
 * extended-length prefix. Chinese user names and deep plugin directories hit
 * this far more often than people expect, and the raw error (ENOENT on a path
 * that visibly exists) is impossible to diagnose from a GUI.
 */
export function longPath(input) {
  if (process.platform !== "win32") return input;
  const absolute = resolve(input);
  if (absolute.length < 240 || absolute.startsWith("\\\\?\\")) return absolute;
  return absolute.startsWith("\\\\")
    ? "\\\\?\\UNC\\" + absolute.slice(2)
    : "\\\\?\\" + absolute;
}
