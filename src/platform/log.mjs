/**
 * Structured logging with mandatory redaction.
 *
 * The pool handles account cookies, OAuth refresh tokens and proxy passwords.
 * A single `JSON.stringify(error)` that carries a request header into a log
 * file is a credential leak, so redaction happens on the way in, not on the
 * way out.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const SECRET_KEY = /(token|secret|password|passwd|cookie|authorization|auth|api[-_]?key|session[-_]?id)$/i;

function isSecretKey(key) {
  // camelCase matters: `accessToken` has no separator before "Token".
  return SECRET_KEY.test(String(key).replace(/[-_]/g, ""));
}

const SECRET_PATTERNS = [
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, "[jwt]"],
  [/\b(gh[opsu]_[A-Za-z0-9]{20,})/g, "[github-token]"],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "[api-key]"],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, "Bearer [redacted]"],
  [/("(?:access|refresh|id)_token"\s*:\s*")[^"]{8,}(")/gi, "$1[redacted]$2"],
];

export function redactText(text) {
  let value = String(text);
  for (const [pattern, replacement] of SECRET_PATTERNS) value = value.replace(pattern, replacement);
  return value;
}

export function redact(value, depth = 0) {
  if (depth > 6) return "[depth]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactText(value);
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value instanceof Error) {
    return { name: value.name, message: redactText(value.message), code: value.code };
  }
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = isSecretKey(key) ? "[redacted]" : redact(item, depth + 1);
  }
  return out;
}

export function createLogger({ file, level = "info", sink } = {}) {
  const levels = { debug: 10, info: 20, warn: 30, error: 40 };
  const threshold = levels[level] ?? levels.info;
  let ready;

  async function write(entry) {
    const line = JSON.stringify(redact(entry)) + "\n";
    if (file) {
      try {
        ready ??= mkdir(dirname(file), { recursive: true }).catch(() => {});
        await ready;
        await appendFile(file, line, { mode: 0o600 });
      } catch {
        /* logging must never break the caller */
      }
    }
    sink?.(line.trimEnd());
    return entry;
  }

  const make = (name) => (message, fields = {}) => {
    if ((levels[name] ?? 20) < threshold) return Promise.resolve();
    return write({ at: new Date().toISOString(), level: name, message: redactText(message), ...redact(fields) });
  };

  return { debug: make("debug"), info: make("info"), warn: make("warn"), error: make("error") };
}
