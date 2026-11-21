import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readJson, writeAtomic, writeExclusive, writeJson } from "../../src/platform/atomic-file.mjs";

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "gptfree-atomic-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("writes and replaces content", async (t) => {
  const dir = await tempDir(t);
  const file = join(dir, "state.json");
  await writeJson(file, { a: 1 });
  assert.deepEqual(await readJson(file), { a: 1 });
  await writeJson(file, { a: 2 });
  assert.deepEqual(await readJson(file), { a: 2 });
  const raw = await readFile(file, "utf8");
  assert.ok(raw.endsWith("\n"));
});

test("leaves no temp files behind", async (t) => {
  const dir = await tempDir(t);
  await writeJson(join(dir, "state.json"), { ok: true });
  const { readdir } = await import("node:fs/promises");
  assert.deepEqual(await readdir(dir), ["state.json"]);
});

test("concurrent writers all succeed and leave valid JSON", async (t) => {
  const dir = await tempDir(t);
  const file = join(dir, "pool.json");
  await Promise.all(
    Array.from({ length: 25 }, (_, i) => writeJson(file, { writer: i, pad: "x".repeat(2000) })),
  );
  const value = await readJson(file);
  assert.equal(typeof value.writer, "number");
  assert.equal(value.pad.length, 2000);
});

test("overwrites a file that was not written atomically", async (t) => {
  const dir = await tempDir(t);
  const file = join(dir, "legacy.json");
  await writeFile(file, "{}", "utf8");
  await writeJson(file, { migrated: true });
  assert.deepEqual(await readJson(file), { migrated: true });
});

test("readJson falls back on a missing or corrupt file", async (t) => {
  const dir = await tempDir(t);
  assert.deepEqual(await readJson(join(dir, "nope.json"), { empty: true }), { empty: true });
  const bad = join(dir, "bad.json");
  await writeFile(bad, "{not json", "utf8");
  assert.deepEqual(await readJson(bad, { empty: true }), { empty: true });
  await assert.rejects(() => readJson(bad));
});

test("writeAtomic returns the original path and is private on POSIX", async (t) => {
  const dir = await tempDir(t);
  const file = join(dir, "secret.json");
  assert.equal(await writeAtomic(file, "{}"), file);
  if (process.platform !== "win32") {
    const info = await stat(file);
    assert.equal(info.mode & 0o777, 0o600);
  }
});

test("writeExclusive never overwrites an existing file", async (t) => {
  const dir = await tempDir(t);
  const key = join(dir, "master.key");
  assert.equal(await writeExclusive(key, Buffer.alloc(32, 1)), true);
  // A second process racing for the same key must lose, not replace the key
  // that already encrypted the vault.
  assert.equal(await writeExclusive(key, Buffer.alloc(32, 2)), false);
  assert.deepEqual(await readFile(key), Buffer.alloc(32, 1));
});
