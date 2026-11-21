/**
 * What changed upstream since our pinned snapshot?
 *
 * Deliberately dumb: read the pinned sha from baseline/UPSTREAM.json, ask GitHub
 * for the compare, and sort the files into "protocol" (needs a box swap),
 * "ui" (only take what fixes a real defect) and "other". No auto-merge, no
 * auto-install — see docs/PROTOCOL.md.
 *
 * Usage:
 *   node scripts/upstream-diff.mjs            human summary
 *   node scripts/upstream-diff.mjs --json     machine output (CI)
 *   node scripts/upstream-diff.mjs --pin      record the current head as baseline
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PIN_FILE = join(ROOT, "baseline/UPSTREAM.json");
const PINNED = JSON.parse(await readFile(PIN_FILE, "utf8"));

const args = new Set(process.argv.slice(2));
const json = args.has("--json");
const pin = args.has("--pin");

const api = async (path) => {
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "magpie-gptfree-next/upstream-diff",
    "x-github-api-version": "2022-11-28",
  };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(`https://api.github.com${path}`, { headers });
  if (!res.ok) throw new Error(`GitHub API ${path} → HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
};

const head = await api(`/repos/${PINNED.repo}/commits/${PINNED.ref}`);
const out = {
  repo: PINNED.repo,
  baselineSha: PINNED.sha,
  headSha: head.sha,
  headDate: head.commit?.committer?.date || "",
  headMessage: (head.commit?.message || "").split("\n")[0],
  changed: head.sha !== PINNED.sha,
  aheadBy: 0,
  protocolFiles: [],
  uiFiles: [],
  otherFiles: [],
};

if (out.changed) {
  const compare = await api(`/repos/${PINNED.repo}/compare/${PINNED.sha}...${head.sha}`);
  out.aheadBy = compare.ahead_by ?? compare.commits?.length ?? 0;
  for (const file of compare.files || []) {
    const entry = { filename: file.filename, status: file.status, additions: file.additions, deletions: file.deletions };
    if (/^(lib|python)\//.test(file.filename)) out.protocolFiles.push(entry);
    else if (/^gui\//.test(file.filename)) out.uiFiles.push(entry);
    else out.otherFiles.push(entry);
  }
}

if (pin) {
  await writeFile(PIN_FILE, JSON.stringify({
    repo: PINNED.repo,
    ref: PINNED.ref,
    sha: out.headSha,
    capturedAt: new Date().toISOString(),
    note: "Pinned upstream commit. The snapshot in baseline/upstream-* corresponds to the version deployed before this pin; update both together.",
  }, null, 2) + "\n");
}

if (json) {
  console.log(JSON.stringify(out, null, 2));
} else {
  if (!out.changed) {
    console.log(`上游无新提交（${PINNED.repo}@${out.headSha.slice(0, 8)}）。`);
  } else {
    console.log(`上游有新提交：${PINNED.repo} ${out.baselineSha.slice(0, 8)} → ${out.headSha.slice(0, 8)}（+${out.aheadBy}）`);
    console.log(`最新：${out.headDate} ${out.headMessage}`);
    const section = (title, files) => {
      if (!files.length) return;
      console.log(`\n${title}（${files.length}）：`);
      for (const file of files.slice(0, 40)) {
        console.log(`  ${file.status.padEnd(9)} +${file.additions}/-${file.deletions}  ${file.filename}`);
      }
      if (files.length > 40) console.log(`  …另有 ${files.length - 40} 个文件`);
    };
    section("协议层 → 需要换箱子", out.protocolFiles);
    section("前端 → 只挑与当前缺陷相关的", out.uiFiles);
    section("其他", out.otherFiles);
    console.log("\n下一步：docs/PROTOCOL.md 的升级流程。不要直接安装上游包。");
  }
  if (pin) console.log(`\n已把基线固定到 ${out.headSha.slice(0, 8)}。`);
}
