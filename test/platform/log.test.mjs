import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLogger, redact, redactText } from "../../src/platform/log.mjs";

test("redacts credential shapes in free text", () => {
  // Built from parts so no literal credential-shaped string sits in the repo.
  const jwt = ["eyJ" + "hbGciOiJIUzI1NiJ9", "eyJ" + "zdWIiOiIxMjM0NTY3ODkwIn0", "c2ln" + "bmF0dXJl"].join(".");
  const text = `a ${jwt} b ghp_${"a".repeat(30)} c sk-${"b".repeat(24)} d Bearer ${"c".repeat(30)}`;
  const out = redactText(text);
  assert.ok(!out.includes(jwt));
  assert.ok(!out.includes("ghp_"));
  assert.ok(!out.includes("sk-"));
  assert.ok(out.includes("[jwt]") && out.includes("[github-token]") && out.includes("[api-key]"));
});

test("redacts secret-named object fields at any depth", () => {
  const input = {
    account: "a@b.c",
    accessToken: "secret-value",
    nested: { cookie: "session=abc", ok: 1 },
    list: [{ refresh_token: "r" }],
  };
  const out = redact(input);
  assert.equal(out.account, "a@b.c");
  assert.equal(out.accessToken, "[redacted]");
  assert.equal(out.nested.cookie, "[redacted]");
  assert.equal(out.nested.ok, 1);
  assert.equal(out.list[0].refresh_token, "[redacted]");
});

test("redacts Error messages but keeps name and code", () => {
  const out = redact(new Error("failed with Bearer abcdefghijklmnopqrstuvwx"));
  assert.equal(out.name, "Error");
  assert.ok(out.message.startsWith("failed with Bearer [redacted]"));
});

test("writes JSONL that never contains the raw secret", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "gptfree-log-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "nested", "plugin.log");
  const log = createLogger({ file });
  await log.info("login failed", { account: "a@b.c", token: "super-secret-token" });
  await log.error("oauth", { headers: { authorization: "Bearer abcdefghijklmnop" } });

  const text = await readFile(file, "utf8");
  const lines = text.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].token, "[redacted]");
  assert.equal(lines[0].account, "a@b.c");
  assert.ok(!text.includes("super-secret-token"));
  assert.ok(!text.includes("abcdefghijklmnop"));
});

test("respects the level threshold and supports a sink", async () => {
  const seen = [];
  const log = createLogger({ level: "warn", sink: (line) => seen.push(line) });
  await log.debug("hidden");
  await log.info("hidden");
  await log.warn("shown");
  assert.equal(seen.length, 1);
  assert.match(seen[0], /shown/);
});
