import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("diagnostics collector runs end to end in smoke mode", () => {
  const result = spawnSync(process.execPath, [join(root, "diagnostics", "collect.mjs"), "--smoke"], {
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /diagnostics smoke ok/);
  assert.match(result.stdout, new RegExp(process.platform));
});
