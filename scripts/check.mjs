#!/usr/bin/env node
/**
 * Dependency-free syntax gate: `node --check` every .mjs/.js file we ship.
 * Runs identically on Windows and Linux, so CI catches a broken import map
 * before anyone installs the plugin.
 */
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

const ROOTS = ["src", "diagnostics", "scripts", "test"];
const SKIP = new Set(["node_modules", "baseline", ".git", "python-venv"]);

async function walk(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (/\.(mjs|js)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const files = [];
for (const root of ROOTS) await walk(root, files);

let failed = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    failed += 1;
    process.stderr.write(`✗ ${relative(process.cwd(), file)}\n${result.stderr}\n`);
  }
}

if (failed) {
  process.stderr.write(`\n${failed} 个文件语法检查失败\n`);
  process.exit(1);
}
process.stdout.write(`语法检查通过：${files.length} 个文件\n`);
