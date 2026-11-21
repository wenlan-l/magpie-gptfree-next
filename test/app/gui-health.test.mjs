import assert from "node:assert/strict";
import { test } from "node:test";
import { request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGuiService, startGuiServer, stopGuiServer } from "../../src/app/gui-service.mjs";
import { SERVICE_MARKER, fetchHealth, readEndpoint } from "../../src/app/lifecycle.mjs";

function get(port, path, { headers = {}, method = "GET" } = {}) {
  return new Promise((resolve, reject) => {
    const call = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    call.on("error", reject);
    call.end();
  });
}

test("the GUI service proves itself on /healthz and /healthz.png", async () => {
  const home = await mkdtemp(join(tmpdir(), "gptfree-gui-"));
  const before = process.env.MAGPIE_GPTFREE_HOME;
  process.env.MAGPIE_GPTFREE_HOME = home;
  const service = createGuiService({ port: 0 });
  try {
    const address = await service.listen();
    const port = typeof address === "number" ? address : address.port;
    const health = await fetchHealth(port);
    assert.equal(health.service, SERVICE_MARKER);
    assert.equal(health.pid, process.pid);
    assert.equal(health.port, port);

    // The diagnostic image remains available without caching.
    const png = await get(port, "/healthz.png");
    assert.equal(png.status, 200);
    assert.equal(png.headers["content-type"], "image/png");
    assert.equal(png.headers["cache-control"], "no-store");
    assert.equal(png.body.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");

    // The probe must not require a session or an Origin header, and must not
    // touch the vault: it answers before any account is configured.
    const ui = await get(port, "/");
    assert.equal(ui.status, 200);
    assert.match(ui.body.toString("utf8"), /GPT号池/);

    // Everything else keeps the existing session + origin gate.
    const denied = await get(port, "/api/status");
    assert.equal(denied.status, 403);
  } finally {
    await service.close().catch(() => {});
    await stopGuiServer();
    if (before === undefined) delete process.env.MAGPIE_GPTFREE_HOME;
    else process.env.MAGPIE_GPTFREE_HOME = before;
    await rm(home, { recursive: true, force: true });
  }
});

test("first startup publishes an endpoint with no existing data directory", async () => {
  const parent = await mkdtemp(join(tmpdir(), "gptfree-first-start-"));
  const home = join(parent, "new-home");
  const before = process.env.MAGPIE_GPTFREE_HOME;
  process.env.MAGPIE_GPTFREE_HOME = home;
  const portFinder = createGuiService({ port: 0 });
  const { port } = await portFinder.listen();
  await portFinder.close();
  try {
    const service = await startGuiServer({ port, home });
    assert.equal(readEndpoint(home)?.port, service.port);
    assert.equal((await fetchHealth(service.port))?.service, SERVICE_MARKER);
  } finally {
    await stopGuiServer();
    if (before === undefined) delete process.env.MAGPIE_GPTFREE_HOME;
    else process.env.MAGPIE_GPTFREE_HOME = before;
    await rm(parent, { recursive: true, force: true });
  }
});
