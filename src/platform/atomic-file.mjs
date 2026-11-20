/**
 * Durable file writes.
 *
 * The account vault is the one file that must never be half-written: it holds
 * every imported account. write-temp-then-rename is atomic on POSIX, but on
 * Windows the rename fails with EPERM/EBUSY/EACCES whenever anything holds a
 * handle to the target — antivirus scanners, OneDrive sync, Explorer preview,
 * or the previous write still closing. Retrying with backoff and falling back
 * to a copy keeps the vault writable instead of failing the whole import.
 */
import { randomBytes } from "node:crypto";
import { copyFile, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { longPath } from "./paths.mjs";

const RETRYABLE = new Set(["EPERM", "EACCES", "EBUSY", "EMFILE", "ENFILE", "EAGAIN"]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function retryable(err) {
  return Boolean(err && RETRYABLE.has(err.code));
}

async function renameWithRetry(from, to, retries, delayMs) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      lastError = err;
      if (!retryable(err) || attempt === retries) break;
      await sleep(delayMs * (attempt + 1));
    }
  }
  // Last resort on Windows: copy over the target, then drop the temp file.
  // Not atomic, but better than losing the write entirely.
  if (process.platform === "win32" && retryable(lastError)) {
    await copyFile(from, to);
    await rm(from, { force: true });
    return;
  }
  throw lastError;
}

export async function writeAtomic(file, data, options = {}) {
  const { mode = 0o600, retries = 8, delayMs = 40 } = options;
  const target = longPath(file);
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const temp = join(
      dirname(target),
      `.${basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
    );
    let handle;
    try {
      handle = await open(temp, "w", mode);
      await handle.writeFile(buffer);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await renameWithRetry(temp, target, retries, delayMs);
      return file;
    } catch (err) {
      lastError = err;
      if (handle) {
        try {
          await handle.close();
        } catch {
          /* ignore */
        }
      }
      try {
        await rm(temp, { force: true });
      } catch {
        /* ignore */
      }
      if (!retryable(err) || attempt === retries) break;
      await sleep(delayMs * (attempt + 1));
    }
  }
  throw lastError;
}

export async function writeJson(file, value, options = {}) {
  return writeAtomic(file, JSON.stringify(value, null, 2) + "\n", options);
}

export async function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(await readFile(longPath(file), "utf8"));
  } catch (err) {
    if (fallback !== undefined && (err.code === "ENOENT" || err.name === "SyntaxError")) {
      return fallback;
    }
    throw err;
  }
}
