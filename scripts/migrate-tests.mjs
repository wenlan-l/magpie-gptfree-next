// Port the upstream regression suite into test/legacy/ with import paths
// rewritten to the new layout. Behaviour stays frozen: these tests are the
// contract that the refactor must not change.
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

const OLD = resolve("baseline/upstream-0.6.6");
const OUT = resolve("test/legacy");

const moved = new Map(
  Object.entries({
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
    "index.mjs": "index.mjs",
  }).map(([o, n]) => [resolve(OLD, o), resolve(n)]),
);

await mkdir(OUT, { recursive: true });
const files = (await readdir(join(OLD, "test"))).filter((f) => f.endsWith(".test.mjs"));
let count = 0;

for (const name of files) {
  const from = join(OLD, "test", name);
  const to = join(OUT, name);
  let text = await readFile(from, "utf8");
  text = text.replace(/(\bfrom\s+|\bimport\s*\(\s*)(["'])(\.\.?\/[^"']*)\2/g, (m, head, q, spec) => {
    const target = moved.get(resolve(dirname(from), spec));
    if (!target) return m;
    let rel = relative(dirname(to), target).replaceAll("\\", "/");
    if (!rel.startsWith(".")) rel = "./" + rel;
    return head + q + rel + q;
  });
  await writeFile(to, text);
  count++;
}
console.log(`ported ${count} upstream test files`);
