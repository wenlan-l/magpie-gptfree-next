#!/usr/bin/env node
/**
 * GPT号池 诊断包
 *
 * 只读取元数据，不读取账号、Cookie、Token 或任何 vault 内容。
 * 在出问题的机器上运行：
 *
 *   node diagnostics/collect.mjs
 *
 * 会在当前目录生成 gptfree-diagnostics-<时间>.json 和同名 .txt，
 * 把 .txt 发出来就能定位大部分环境问题。
 */
import { access, readFile, readdir, stat } from "node:fs/promises";
import { connect } from "node:net";
import { homedir, platform, release, arch, cpus, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { pluginHome } from "../src/platform/paths.mjs";
import { pythonCandidates, probePython, venvPython, venvDir } from "../src/platform/python.mjs";
import { runCommand } from "../src/platform/proc.mjs";

const SMOKE = process.argv.includes("--smoke");
const PORT = Number(process.env.MAGPIE_GPTFREE_PORT || 37986);
const HOME = homedir();

const mask = (value) => String(value).split(HOME).join("~");

async function safe(fn, fallback = null) {
  try {
    return await fn();
  } catch (err) {
    return { error: err.code || err.message };
  }
}

async function dirListing(dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch (err) {
    return { entries: [], error: err.code || err.message };
  }
  const rows = [];
  for (const name of names.slice(0, 50)) {
    const info = await safe(() => stat(join(dir, name)));
    rows.push({
      name,
      size: info?.size ?? null,
      dir: info?.isDirectory?.() ?? null,
      modified: info?.mtime ? info.mtime.toISOString() : null,
    });
  }
  return { entries: rows };
}

function portProbe(port, host = "127.0.0.1", timeout = 1500) {
  return new Promise((resolveProbe) => {
    const socket = connect({ port, host });
    const done = (result) => {
      socket.removeAllListeners();
      socket.destroy();
      resolveProbe(result);
    };
    socket.setTimeout(timeout);
    socket.once("connect", () => done({ listening: true }));
    socket.once("timeout", () => done({ listening: false, reason: "timeout" }));
    socket.once("error", (err) => done({ listening: false, reason: err.code || err.message }));
  });
}

async function portOwner(port) {
  if (platform() === "win32") {
    const netstat = await safe(() => runCommand("netstat", ["-ano"], { timeout: 15_000 }));
    if (!netstat?.stdout) return null;
    const line = netstat.stdout
      .split(/\r?\n/)
      .find((l) => l.includes(`:${port}`) && /LISTENING/i.test(l));
    if (!line) return null;
    const pid = line.trim().split(/\s+/).pop();
    const task = await safe(() => runCommand("tasklist", ["/FI", `PID eq ${pid}`], { timeout: 15_000 }));
    return { pid, task: task?.stdout?.split(/\r?\n/)[3]?.trim() || null };
  }
  const result = await safe(() => runCommand("sh", ["-c", `ss -lptn 'sport = :${port}' 2>/dev/null || lsof -nP -iTCP:${port} -sTCP:LISTEN 2>/dev/null`], { timeout: 10_000 }));
  return result?.stdout?.trim() || null;
}

async function longPathsEnabled() {
  if (platform() !== "win32") return null;
  const result = await safe(() => runCommand("reg", [
    "query", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem", "/v", "LongPathsEnabled",
  ], { timeout: 10_000 }));
  if (!result?.stdout) return null;
  const match = result.stdout.match(/LongPathsEnabled\s+REG_DWORD\s+0x([0-9a-f]+)/i);
  return match ? Number.parseInt(match[1], 16) === 1 : null;
}

async function magpieProcesses() {
  if (platform() === "win32") {
    const result = await safe(() => runCommand("tasklist", ["/FI", "IMAGENAME eq magpie*"], { timeout: 15_000 }));
    return result?.stdout?.split(/\r?\n/).filter((l) => /magpie/i.test(l)) ?? [];
  }
  const result = await safe(() => runCommand("sh", ["-c", "ps -eo pid,etime,comm,args | grep -i magpie | grep -v grep"], { timeout: 10_000 }));
  return result?.stdout?.trim().split(/\r?\n/).filter(Boolean) ?? [];
}

async function pythonReport(home) {
  const attempts = [];
  for (const candidate of pythonCandidates({ home })) {
    const exists = await safe(() => access(candidate.command).then(() => true), false);
    let probe = null;
    try {
      const info = await probePython(candidate, { timeout: 20_000 });
      probe = `${info.major}.${info.minor}.${info.micro} (${mask(info.executable)})`;
    } catch (err) {
      probe = `失败: ${err.message.split("\n")[0]}`;
    }
    attempts.push({ command: mask(candidate.command), args: candidate.args, inPath: exists === true, probe });
  }
  const venv = venvPython(home);
  const venvExists = await safe(() => access(venv).then(() => true), false);
  return { candidates: attempts, venv: mask(venv), venvExists: venvExists === true };
}

async function magpieRuntime() {
  // Best effort: the host exposes a read-only CLI inside the container/binary.
  const candidates = [
    ["magpie", ["version"]],
    ["magpie", ["plugin", "list", "--json"]],
  ];
  const out = {};
  for (const [bin, args] of candidates) {
    const result = await safe(() => runCommand(bin, args, { timeout: 10_000 }));
    out[args.join(" ")] = result?.stdout?.trim().slice(0, 4000) || result?.error || null;
  }
  return out;
}

async function main() {
  const home = pluginHome();
  const report = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: platform(),
    release: release(),
    arch: arch(),
    cpu: cpus()?.[0]?.model ?? null,
    cpuCount: cpus()?.length ?? null,
    memoryGB: Math.round(totalmem() / 1024 ** 3),
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    env: {
      home: mask(HOME),
      cwd: mask(process.cwd()),
      pluginHome: mask(home),
      MAGPIE_GPTFREE_HOME: process.env.MAGPIE_GPTFREE_HOME ? mask(process.env.MAGPIE_GPTFREE_HOME) : null,
      MAGPIE_GPTFREE_PYTHON: process.env.MAGPIE_GPTFREE_PYTHON ? mask(process.env.MAGPIE_GPTFREE_PYTHON) : null,
      MAGPIE_GPTFREE_PORT: process.env.MAGPIE_GPTFREE_PORT || null,
      oneDrive: process.env.OneDrive ? mask(process.env.OneDrive) : null,
      temp: mask(process.env.TEMP || process.env.TMPDIR || ""),
    },
    windows: platform() === "win32" ? { longPathsEnabled: await longPathsEnabled() } : null,
    pluginHome: {
      path: mask(home),
      exists: await safe(() => access(home).then(() => true), false) === true,
      venvDir: mask(venvDir(home)),
      ...(await dirListing(home)),
    },
    python: await pythonReport(home),
    port: { port: PORT, ...(await portProbe(PORT)), owner: await portOwner(PORT) },
    processes: await magpieProcesses(),
    magpie: await magpieRuntime(),
    notes: [],
  };

  if (platform() === "win32" && report.windows.longPathsEnabled === false) {
    report.notes.push("LongPathsEnabled=0：中文用户名 + 深层目录可能触发 ENOENT，可考虑开启长路径支持。");
  }
  if (report.env.oneDrive && home.includes("OneDrive")) {
    report.notes.push("插件数据目录位于 OneDrive 同步范围内：同步进程会持有文件句柄，导致 vault 写入 EBUSY。");
  }
  if (report.port.listening && !report.port.owner) {
    report.notes.push(`端口 ${PORT} 已被其他进程占用（可能是上一轮残留进程）。`);
  }
  if (!report.port.listening) {
    report.notes.push(`端口 ${PORT} 当前无监听：插件侧车未启动，或已崩溃。`);
  }
  if (!report.python.venvExists) {
    report.notes.push("Python venv 不存在：首次运行或依赖安装失败。");
  }

  const text = [
    `GPT号池诊断包 ${report.generatedAt}`,
    `Node ${report.node} · ${report.platform} ${report.release} ${report.arch} · ${report.cpuCount}C/${report.memoryGB}GB`,
    "",
    "【数据目录】" + report.pluginHome.path + (report.pluginHome.exists ? "" : " (不存在)"),
    ...report.pluginHome.entries.slice(0, 20).map((e) => `  - ${e.name} ${e.size ?? ""}`.trimEnd()),
    "",
    "【Python】",
    ...report.python.candidates.map((c) => `  ${c.command} ${c.args.join(" ")} → ${c.probe}`),
    `  venv: ${report.python.venv} (${report.python.venvExists ? "存在" : "缺失"})`,
    "",
    `【端口 ${PORT}】${report.port.listening ? "监听中" : "未监听 " + (report.port.reason || "")}`,
    report.port.owner ? `  占用: ${report.port.owner.pid || report.port.owner}` : "",
    "",
    "【进程】",
    ...report.processes.slice(0, 10).map((l) => "  " + l),
    "",
    "【提示】",
    ...(report.notes.length ? report.notes.map((n) => "  ! " + n) : ["  无"]),
    "",
  ].filter((line) => line !== "").join("\n");

  if (SMOKE) {
    process.stdout.write(`diagnostics smoke ok: ${report.platform} node ${report.node} port ${PORT} ${report.port.listening ? "up" : "down"}\n`);
    return;
  }

  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  const base = resolve(process.cwd(), `gptfree-diagnostics-${stamp}`);
  const { writeAtomic } = await import("../src/platform/atomic-file.mjs");
  await writeAtomic(`${base}.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
  await writeAtomic(`${base}.txt`, text, { mode: 0o600 });
  process.stdout.write(text + `\n已写入:\n  ${base}.json\n  ${base}.txt\n`);
}

main().catch((err) => {
  process.stderr.write(`诊断失败: ${err?.stack || err}\n`);
  process.exitCode = 1;
});
