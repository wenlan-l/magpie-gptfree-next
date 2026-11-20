import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { APP_DIR_NAME, longPath, pluginHome } from "../../src/platform/paths.mjs";

test("pluginHome defaults under the user home", () => {
  assert.equal(pluginHome({}), resolve(join(homedir(), APP_DIR_NAME)));
});

test("pluginHome honours an explicit override and trims it", () => {
  assert.equal(pluginHome({ MAGPIE_GPTFREE_HOME: "  /tmp/gptfree-test  " }), resolve("/tmp/gptfree-test"));
});

test("pluginHome ignores blank overrides", () => {
  assert.equal(pluginHome({ MAGPIE_GPTFREE_HOME: "   " }), resolve(join(homedir(), APP_DIR_NAME)));
});

test("relative overrides become absolute", () => {
  assert.equal(pluginHome({ MAGPIE_GPTFREE_HOME: "state" }), resolve("state"));
});

test("longPath is a no-op off Windows and prefixes deep paths on Windows", () => {
  if (process.platform !== "win32") {
    assert.equal(longPath("/tmp/x"), "/tmp/x");
    return;
  }
  const deep = "C:\\" + Array.from({ length: 40 }, (_, i) => `segment-${i}`).join("\\");
  assert.ok(longPath(deep).startsWith("\\\\?\\"));
  assert.equal(longPath("C:\\short"), "C:\\short");
});
