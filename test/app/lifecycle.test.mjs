import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EPHEMERAL_SPAN,
  SERVICE_MARKER,
  clearEndpoint,
  fetchHealth,
  isAlive,
  readEndpoint,
  startWithFallback,
  writeEndpoint,
} from "../../src/app/lifecycle.mjs";

const tempHome = () => mkdtemp(join(tmpdir(), "gptfree-lifecycle-"));

/** Minimal stand-in for the real service: answers /healthz with a marker. */
function healthServer({ pid = process.pid } = {}) {
  const server = createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ service: SERVICE_MARKER, ok: true, pid, port: server.address().port }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return server;
}

const listen = (server, port = 0) =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });

test("fetchHealth ignores anything that does not carry our marker", async () => {
  const foreign = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "something-else" }));
  });
  const port = await listen(foreign);
  try {
    assert.equal(await fetchHealth(port), null);
  } finally {
    await new Promise((resolve) => foreign.close(resolve));
  }
  // A closed port must resolve to null quickly, never reject.
  assert.equal(await fetchHealth(port, { timeout: 300 }), null);
});

test("fetchHealth reads the marker, pid and port of a live service", async () => {
  const server = healthServer({ pid: 4242 });
  const port = await listen(server);
  try {
    const health = await fetchHealth(port);
    assert.equal(health.service, SERVICE_MARKER);
    assert.equal(health.pid, 4242);
    assert.equal(health.port, port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("the endpoint file records the chosen port and is not world readable", async () => {
  const home = await tempHome();
  try {
    await writeEndpoint({ port: 41000, pid: process.pid, version: "test" }, home);
    const saved = readEndpoint(home);
    assert.equal(saved.port, 41000);
    assert.equal(saved.service, SERVICE_MARKER);
    if (process.platform !== "win32") {
      const info = await stat(join(home, "gui-endpoint.json"));
      assert.equal(info.mode & 0o777, 0o600);
    }
    await clearEndpoint(home);
    assert.equal(readEndpoint(home), null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("startWithFallback binds the preferred port when it is free", async () => {
  const home = await tempHome();
  const server = healthServer();
  try {
    const opened = await listen(server, 0);
    await new Promise((resolve) => server.close(resolve));
    const picked = await startWithFallback({
      preferred: opened,
      home,
      listen: async (port) => listen(server, port),
    });
    assert.equal(picked.port, opened);
    assert.equal(picked.reused, false);
    assert.equal(readEndpoint(home).port, opened);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
});

test("a foreign listener on the preferred port pushes the service forward", async () => {
  const home = await tempHome();
  const foreign = createServer((_req, res) => { res.writeHead(200); res.end("not ours"); });
  const busyPort = await listen(foreign);
  const server = healthServer();
  try {
    const picked = await startWithFallback({
      preferred: busyPort,
      home,
      listen: async (port) => listen(server, port),
    });
    assert.notEqual(picked.port, busyPort);
    assert.ok(picked.port > busyPort && picked.port <= busyPort + EPHEMERAL_SPAN);
    assert.equal(picked.reused, false);
    assert.equal(readEndpoint(home).port, picked.port);
    assert.equal((await fetchHealth(picked.port)).port, picked.port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => foreign.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
});

test("a stale copy of ourselves is reclaimed before falling forward", async () => {
  const home = await tempHome();
  const stalePid = 987654;
  // The endpoint file claims the port; the health answer agrees on pid.
  await writeEndpoint({ port: 41500, pid: stalePid, version: "old" }, home);
  const server = healthServer({ pid: stalePid });
  const killed = [];
  try {
    const picked = await startWithFallback({
      preferred: 41500,
      home,
      listen: async (port) => listen(server, port),
      // Nothing is bound yet, so listen() succeeds immediately; the point is
      // that the kill is attempted only for a recorded stale owner.
      kill: async (pid) => { killed.push(pid); },
      alive: () => true,
      probe: async (port) => (port === 41500
        ? { service: SERVICE_MARKER, pid: stalePid, port }
        : null),
    });
    assert.deepEqual(killed, [stalePid]);
    assert.equal(picked.port, 41500);
    assert.equal(picked.reclaimed, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
});

test("a health answer we never recorded is left alone, not killed", async () => {
  const home = await tempHome();
  await writeEndpoint({ port: 41600, pid: 1234, version: "old" }, home);
  const killed = [];
  const server = healthServer();
  try {
    const picked = await startWithFallback({
      preferred: 41600,
      home,
      listen: async (port) => {
        if (port === 41600) {
          const error = new Error("in use");
          error.code = "EADDRINUSE";
          throw error;
        }
        return listen(server, port);
      },
      kill: async (pid) => { killed.push(pid); },
      alive: () => true,
      probe: async (port) => (port === 41600
        ? { service: SERVICE_MARKER, pid: 999999, port }
        : null),
    });
    assert.deepEqual(killed, []);
    assert.equal(picked.port, 41601);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
});

test("an exhausted port range reports every attempt instead of hanging", async () => {
  const home = await tempHome();
  try {
    // Every candidate answers as a live service we do not own, and every bind
    // fails: the caller must get one aggregated error, not a retry loop.
    const claimed = [41700, 41701, 41702];
    await assert.rejects(
      startWithFallback({
        preferred: 41700,
        span: 2,
        home,
        probe: async (candidate) => (claimed.includes(candidate)
          ? { service: SERVICE_MARKER, pid: 500000 + candidate, port: candidate }
          : null),
        alive: () => true,
        kill: async () => {},
        listen: async () => {
          const error = new Error("in use");
          error.code = "EADDRINUSE";
          throw error;
        },
      }),
      (error) => {
        assert.equal(error.code, "ENOPORT");
        assert.equal(error.attempts.length, 3);
        assert.match(error.message, /均被占用/);
        return true;
      },
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a non-EADDRINUSE bind error is not retried on other ports", async () => {
  const home = await tempHome();
  try {
    let calls = 0;
    await assert.rejects(
      startWithFallback({
        preferred: 42000,
        home,
        probe: async () => null,
        listen: async () => {
          calls += 1;
          const error = new Error("permission denied");
          error.code = "EACCES";
          throw error;
        },
      }),
      /permission denied/,
    );
    assert.equal(calls, 1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("isAlive reports our own pid and rejects nonsense", () => {
  assert.equal(isAlive(process.pid), true);
  assert.equal(isAlive(0), false);
  assert.equal(isAlive(-1), false);
  assert.equal(isAlive("abc"), false);
});
