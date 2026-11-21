/**
 * Contract test for the protocol box.
 *
 * src/protocol/ is vendored reverse-engineered code (sentinel, Turnstile, PoW,
 * PKCE). It is deliberately *not* rewritten: when upstream changes, we swap the
 * box contents and re-run this file. So it asserts the shape the rest of the
 * plugin depends on, plus the invariants that keep the box from leaking.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (path) => readFile(join(ROOT, path), "utf8");

const MODULES = {
  "src/protocol/codex-pool.mjs": [
    "CODEX_BASE", "CODEX_VERSION", "isWebOnlyToken", "isCodexToken", "parseCodexCatalog",
    "verifyAccessToken", "prepareCodexBody", "renewAccount", "discoverPoolModels",
    "probeAccountImageQuota", "refreshPoolAccount", "poolFetch",
  ],
  "src/protocol/chatgpt-web-text.mjs": [
    "WEB_TEXT_WORKER", "DEFAULT_WEB_TEXT_MODEL", "WEB_TEXT_MODEL_SPECS", "WebTextHttpError",
    "clearTextCooldowns", "buildWebTextModelCatalog", "normalizeRequestedTextModel",
    "extractWebTextRequest", "runWebTextWorker", "buildResponsesPayload", "executeWebTextGeneration",
  ],
  "src/protocol/chatgpt-web-image.mjs": [
    "IMAGE_WORKER", "IMAGE_MODEL_ID", "IMAGE_MODEL_IDS", "ImageHttpError",
    "normalizeImageModelId", "isImageModelId", "supportsGifOutput", "buildImageModelCatalog",
    "parseImageRequest", "runWebImageWorker", "checkWebImageQuota", "executeWebImageGeneration",
  ],
  "src/protocol/dsh-http-auth.mjs": [
    "workerPython", "normalizeWorkerResult", "loginHTTPAccount",
  ],
};

test("every protocol module still exports the surface the app layer calls", async () => {
  for (const [file, names] of Object.entries(MODULES)) {
    const mod = await import(pathToFileURL(join(ROOT, file)).href);
    for (const name of names) {
      assert.ok(name in mod, `${file} no longer exports ${name}`);
    }
  }
});

test("the vendored Python workers and their dependencies are present", async () => {
  const expected = [
    "python/image_worker.py",
    "python/web_text_worker.py",
    "python/auth_worker.py",
    "python/requirements.txt",
    "python/utils/__init__.py",
    "python/utils/pkce.py",
    "python/utils/sentinel.py",
    "python/utils/turnstile.py",
    "python/utils/web_pow.py",
  ];
  for (const file of expected) {
    const info = await stat(join(ROOT, file));
    assert.ok(info.size > 0, `${file} is empty`);
  }
  const reqs = await read("python/requirements.txt");
  // Pinned on purpose: an unpinned curl_cffi silently changes TLS fingerprints
  // and the whole web path starts failing with 403s.
  for (const line of reqs.split("\n").map((l) => l.trim())) {
    if (!line || line.startsWith("#")) continue;
    assert.match(line, /^[A-Za-z0-9_.-]+(==|>=|~=|>)/, `unpinned requirement: ${line}`);
  }
});

test("protocol code never reaches around the platform layer", async () => {
  const banned = [
    [/\bfrom\s+["']node:os["']/, "node:os"],
    [/\bfrom\s+["']node:child_process["']/, "node:child_process"],
    [/\bfrom\s+["']node:net["']/, "node:net"],
  ];
  for (const file of Object.keys(MODULES)) {
    const text = await read(file);
    for (const [pattern, label] of banned) {
      assert.doesNotMatch(text, pattern, `${file} imports ${label}`);
    }
  }
});

test("every Python invocation goes through the platform runner", async () => {
  // A raw spawn() here would skip UTF-8 decoding and process-tree cleanup,
  // which is exactly what produced mojibake and orphaned workers on Windows.
  for (const file of [
    "src/protocol/chatgpt-web-text.mjs",
    "src/protocol/chatgpt-web-image.mjs",
    "src/protocol/dsh-http-auth.mjs",
  ]) {
    const text = await read(file);
    assert.doesNotMatch(text, /node:child_process|\bspawn\(|\bexecFile\(/, `${file} spawns processes directly`);
    assert.match(text, /from\s+["']\.\.\/platform\/proc\.mjs["']/, `${file} does not use the platform runner`);
  }
});

test("the JS side of the worker protocol still speaks the documented frames", async () => {
  // These are the field names the Python workers emit/consume. Changing one
  // without the other is the classic silent breakage after an upstream bump.
  const image = await read("src/protocol/chatgpt-web-image.mjs");
  const text = await read("src/protocol/chatgpt-web-text.mjs");
  // Action names are the JS<->worker contract: if the worker renames one of
  // these, the rebuilt box must be re-wired, not silently mismatched.
  for (const action of ["check_image_quota", "ok", "error_code"]) {
    assert.ok(image.includes(action), `image worker contract lost "${action}"`);
  }
  assert.match(text, /runWebTextWorker/, "text worker entry point missing");
  const pyImage = await read("python/image_worker.py");
  assert.match(pyImage, /json\.dumps|print\(/, "image worker no longer writes JSON frames");
  const pyText = await read("python/web_text_worker.py");
  assert.match(pyText, /json\.(dumps|loads)/, "text worker no longer speaks JSON");
});

test("THIRD_PARTY notices cover every vendored worker", async () => {
  const notice = await read("python/THIRD_PARTY.md");
  for (const source of ["yang0/chatgpt2api-dsh", "yang0/magpie-gptfree"]) {
    assert.match(notice, new RegExp(source.replace(/[/.]/g, "\\$&")), `THIRD_PARTY.md lost ${source}`);
  }
});
