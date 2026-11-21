// One-off codemod: move upstream files into the new layered layout and
// rewrite relative imports so each file still resolves its neighbours.
import { readFile, writeFile, mkdir, cp } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

const OLD = "baseline/upstream-0.6.6";
const MAP = {
  "lib/credentials.mjs": "src/core/credentials.mjs",
  "lib/importer.mjs": "src/app/importer.mjs",
  "lib/pool-vault.mjs": "src/storage/pool-vault.mjs",
  "lib/pool-stats.mjs": "src/storage/pool-stats.mjs",
  "lib/codex-pool.mjs": "src/protocol/codex-pool.mjs",
  "lib/chatgpt-web-text.mjs": "src/protocol/chatgpt-web-text.mjs",
  "lib/chatgpt-web-image.mjs": "src/protocol/chatgpt-web-image.mjs",
  "lib/dsh-http-auth.mjs": "src/protocol/dsh-http-auth.mjs",
  "lib/pool-connection.mjs": "src/app/pool-connection.mjs",
  "lib/gui-service.mjs": "src/app/gui-service.mjs",
  "lib/provider-native-signin.mjs": "src/app/provider-native-signin.mjs",
  "lib/native-file-dialog.mjs": "src/platform/file-dialog.mjs",
  "gui/entry.html": "src/gui/entry.html",
  "gui/entry.js": "src/gui/entry.js",
  "gui/app.js": "src/gui/app.js",
  "gui/app.css": "src/gui/app.css",
  "bin/import.mjs": "bin/import.mjs",
};

const moved = new Map(Object.entries(MAP).map(([o, n]) => [resolve(OLD, o), resolve(n)]));
const isCode = (p) => /\.(mjs|js)$/.test(p);

let rewritten = 0;
for (const [oldPath, newPath] of moved) {
  if (!isCode(oldPath)) continue;
  await mkdir(dirname(newPath), { recursive: true });
  let text = await readFile(oldPath, "utf8");
  text = text.replace(/(\bfrom\s+|\bimport\s*\(\s*)(["'])(\.[^"']*)\2/g, (m, head, q, spec) => {
    const target = moved.get(resolve(dirname(oldPath), spec));
    if (!target) return m;
    let rel = relative(dirname(newPath), target).replaceAll("\\", "/");
    if (!rel.startsWith(".")) rel = "./" + rel;
    return head + q + rel + q;
  });
  await writeFile(newPath, text);
  rewritten++;
}

// Static assets and the Python runtime are copied verbatim.
for (const dir of ["gui", "python"]) {
  await cp(join(OLD, dir), dir === "gui" ? "src/gui" : "python", { recursive: true, force: true });
}
await cp(join(OLD, "gui/entry.html"), "src/gui/entry.html", { force: true });

console.log(`rewrote ${rewritten} modules`);
