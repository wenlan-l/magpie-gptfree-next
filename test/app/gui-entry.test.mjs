import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const entry = await readFile(new URL("../../src/gui/entry.js", import.meta.url), "utf8");

for (const [name, service, options, target] of [
  ["web", "../../_magpie/service/", {}, "https://magpie.example/_magpie/plugin/test/_magpie/service/"],
  ["desktop", "", { port: 38986 }, "http://127.0.0.1:38986/ui"],
]) {
  test(`sidebar navigates its own frame on ${name}`, async () => {
    let destination;
    const elements = new Map();
    await runInNewContext(entry, {
      URL,
      location: {
        href: "https://magpie.example/_magpie/plugin/test/src/gui/entry.html",
        replace(url) { destination = url; },
      },
      magpie: {
        ready: Promise.resolve(), service,
        onAction(fn) { fn({ id: "manage-pool" }); },
        options: { async get() { return options; } },
      },
      setTimeout() {},
      document: {
        getElementById(id) {
          if (!elements.has(id)) elements.set(id, { addEventListener() {} });
          return elements.get(id);
        },
      },
    });
    assert.equal(destination, target + "#action=manage-pool");
  });
}
