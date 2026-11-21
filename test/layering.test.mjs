/**
 * Layering gate: the invariants in docs/ARCHITECTURE.md, enforced.
 *
 * These are not style rules. Each one exists because the upstream layout broke
 * it and the result was a Windows-only bug that could not be reproduced on the
 * developer's machine.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(join(ROOT, dir), { withFileTypes: true })) {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(rel)));
    else if (entry.name.endsWith(".mjs")) out.push(rel);
  }
  return out;
}

const files = [...(await walk("src")), "index.mjs", ...(await walk("scripts")), ...(await walk("diagnostics"))];
const source = new Map(await Promise.all(
  files.map(async (file) => [file, await readFile(join(ROOT, file), "utf8")]),
));

const importsOf = (text) =>
  [...text.matchAll(/(?:^|\n)\s*(?:import|export)[^;\n]*?from\s+["']([^"']+)["']/g)].map((m) => m[1]);

test("only src/platform may touch the operating system", () => {
  const banned = ["node:os", "node:child_process", "node:net"];
  const offenders = [];
  for (const [file, text] of source) {
    if (file.startsWith("src/platform/")) continue;
    for (const spec of importsOf(text)) {
      if (banned.includes(spec)) offenders.push(`${file} → ${spec}`);
    }
  }
  // scripts/ and diagnostics/ are tools, not plugin code: they may probe the
  // machine, but they must not be imported by the plugin.
  const pluginOffenders = offenders.filter((line) => line.startsWith("src/"));
  assert.deepEqual(pluginOffenders, [], `平台能力泄漏：\n${pluginOffenders.join("\n")}`);
});

test("src/core is pure logic: no filesystem, no paths", () => {
  const offenders = [];
  for (const [file, text] of source) {
    if (!file.startsWith("src/core/")) continue;
    for (const spec of importsOf(text)) {
      if (spec === "node:fs" || spec === "node:fs/promises" || spec === "node:path") {
        offenders.push(`${file} → ${spec}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `core 层碰到了文件系统：\n${offenders.join("\n")}`);
});

test("dependencies only point downwards", () => {
  const rank = (file) => {
    if (file.startsWith("src/platform/")) return 0;
    if (file.startsWith("src/core/")) return 1;
    if (file.startsWith("src/storage/")) return 2;
    if (file.startsWith("src/protocol/")) return 3;
    if (file.startsWith("src/app/")) return 4;
    if (file.startsWith("src/gui/")) return 5;
    return 6;
  };
  const offenders = [];
  for (const [file, text] of source) {
    if (!file.startsWith("src/")) continue;
    for (const spec of importsOf(text)) {
      const target = spec.startsWith(".")
        ? relative(ROOT, join(ROOT, file, "..", spec)).replaceAll("\\", "/")
        : "";
      if (!target.startsWith("src/")) continue;
      if (rank(target) > rank(file)) offenders.push(`${file} → ${target}`);
    }
  }
  assert.deepEqual(offenders, [], `反向依赖：\n${offenders.join("\n")}`);
});

test("every child process is spawned with shell disabled", () => {
  for (const [file, text] of source) {
    if (!text.includes("spawn(")) continue;
    assert.match(text, /shell:\s*false/, `${file} spawns without shell: false`);
  }
});

test("no module writes files outside the atomic writer", () => {
  const offenders = [];
  for (const [file, text] of source) {
    if (!file.startsWith("src/")) continue;
    if (file.startsWith("src/platform/")) continue;
    // writeFile/appendFile/rename directly = torn files on Windows.
    for (const call of ["writeFile(", "appendFile(", "rename(", "createWriteStream("]) {
      if (text.includes(call)) offenders.push(`${file} → ${call}`);
    }
  }
  assert.deepEqual(offenders, [], `绕过 writeAtomic 的写入：\n${offenders.join("\n")}`);
});

test("no module sets POSIX permissions outside the platform layer", async () => {
  const offenders = [];
  for (const [file, text] of source) {
    if (file.startsWith("src/platform/")) continue;
    if (/\bchmod(Sync)?\(/.test(text)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `chmod 在 Windows 上是空操作：\n${offenders.join("\n")}`);
});

test("gui files stay dependency-free and buildless", async () => {
  const gui = await walk("src/gui");
  for (const file of gui) {
    const text = await readFile(join(ROOT, file), "utf8");
    if (!file.endsWith(".js")) continue;
    for (const spec of importsOf(text)) {
      assert.ok(spec.startsWith(".") || spec.startsWith("/assets/"), `${file} imports ${spec}`);
    }
  }
});
