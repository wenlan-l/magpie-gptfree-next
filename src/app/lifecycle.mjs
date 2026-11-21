/**
 * GUI sidecar lifecycle: endpoint discovery, port fallback, stale reclaim.
 *
 * Why this module exists
 * ----------------------
 * Upstream bound one fixed port and, when that failed, still let the sidebar
 * navigate to `http://127.0.0.1:PORT/ui`. Any hiccup (host restart overlap, a
 * leftover process, a foreign program on 37986) therefore produced a browser
 * error page inside the plugin frame: a white board with no way back, because
 * the retry timer lived in the document that had just been replaced.
 *
 * The rules here:
 *   1. The health endpoint identifies a listener before reclaim is considered.
 *   2. Internal callers can fall forward to the next port when a port is busy.
 *      Magpie’s page proxy remains pinned to its configured port.
 *   3. A stale copy of *ourselves* (our marker, the pid from our own endpoint
 *      file, still alive) is reclaimed. Anything else is left untouched.
 */
import { request as httpRequest } from "node:http";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { writeJson } from "../platform/atomic-file.mjs";
import { ensureDir, pluginHome } from "../platform/paths.mjs";
import { killPid } from "../platform/proc.mjs";

export const SERVICE_MARKER = "gptfree-gui";
export const EPHEMERAL_SPAN = 9;

export function endpointFile(home = pluginHome()) {
  return join(home, "gui-endpoint.json");
}

export function readEndpoint(home = pluginHome()) {
  try {
    const raw = JSON.parse(readFileSync(endpointFile(home), "utf8"));
    if (raw?.service !== SERVICE_MARKER) return null;
    const port = Number(raw.port);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return null;
    return { ...raw, port };
  } catch {
    return null;
  }
}

export async function writeEndpoint(info, home = pluginHome()) {
  await ensureDir(home);
  await writeJson(endpointFile(home), { service: SERVICE_MARKER, ...info }, { mode: 0o600 });
}

export async function clearEndpoint(home = pluginHome()) {
  await rm(endpointFile(home), { force: true });
}

export function isAlive(pid, signal = 0) {
  const n = Number(pid);
  if (!Number.isSafeInteger(n) || n <= 0) return false;
  try {
    process.kill(n, signal);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/** One GET /healthz with a hard deadline; null for anything not provably ours. */
export function fetchHealth(port, { host = "127.0.0.1", timeout = 800 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const req = httpRequest({ host, port, path: "/healthz", method: "GET", timeout }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return finish(null);
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
        if (body.length > 8192) req.destroy();
      });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          finish(parsed?.service === SERVICE_MARKER ? parsed : null);
        } catch {
          finish(null);
        }
      });
      res.on("error", () => finish(null));
    });
    req.on("timeout", () => {
      req.destroy();
      finish(null);
    });
    req.on("error", () => finish(null));
    const timer = setTimeout(() => {
      req.destroy();
      finish(null);
    }, timeout);
    timer.unref?.();
    req.end();
  });
}

// Deliberately not unref'd: an unref'd timer lets the event loop drain while
// the caller still awaits, which resolves as "promise still pending".
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Binds the first usable port in [preferred, preferred + span].
 *
 * `listen(port)` must reject with `code === "EADDRINUSE"` when the port is
 * taken; every other error is propagated, because a permission or firewall
 * failure is not fixed by trying the next port.
 */
export async function startWithFallback({
  preferred,
  span = EPHEMERAL_SPAN,
  home = pluginHome(),
  listen,
  probe = fetchHealth,
  alive = isAlive,
  kill = killPid,
  version = "",
  log,
  now = () => new Date().toISOString(),
} = {}) {
  const base = Number(preferred);
  if (!Number.isSafeInteger(base) || base < 1 || base > 65535) {
    throw new Error("GUI 端口不合法");
  }
  const attempts = [];
  const claimed = readEndpoint(home);
  const last = Math.min(65535, base + Math.max(0, span));

  for (let port = base; port <= last; port++) {
    const health = await probe(port);
    if (health && Number(health.pid) === process.pid) {
      return { port, reused: true, attempts };
    }
    if (health) {
      const mine = claimed && Number(claimed.pid) === Number(health.pid);
      if (mine && alive(Number(health.pid))) {
        log?.warn?.("reclaiming stale gui service", { port, pid: Number(health.pid) });
        try {
          await kill(Number(health.pid));
          await sleep(250);
        } catch {
          /* the next listen() call decides whether it actually went away */
        }
      }
    }
    try {
      await listen(port);
      await writeEndpoint(
        { port, pid: process.pid, version, startedAt: now() },
        home,
      );
      return { port, reused: false, reclaimed: Boolean(health && claimed), attempts };
    } catch (err) {
      attempts.push({ port, code: err?.code ?? null, message: String(err?.message || err) });
      if (err?.code !== "EADDRINUSE") throw err;
    }
  }

  const error = new Error(base === last
    ? `本地服务端口 ${base} 已被占用，请关闭占用该端口的程序或修改插件端口`
    : `本地服务端口 ${base}–${last} 均被占用`);
  error.code = "ENOPORT";
  error.attempts = attempts;
  throw error;
}
