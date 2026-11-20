#!/usr/bin/env node
/**
 * Deterministic test entry point.
 *
 * `node --test <dir>` behaviour differs across Node versions and bare
 * `node --test` would also pick up the vendored upstream tests under
 * baseline/. Expanding the file list here keeps CI identical on Node 20/22
 * and on Windows/Linux.
 */
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

async function walk(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.name.endsWith(".test.mjs")) out.push(full);
  }
  return out;
}

const files = await walk("test");
if (!files.length) {
  process.stderr.write("没有找到测试文件\n");
  process.exit(1);
}
process.stdout.write(`运行 ${files.length} 个测试文件\n`);
const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
