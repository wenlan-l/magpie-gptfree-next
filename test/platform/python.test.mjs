import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CommandError } from "../../src/platform/proc.mjs";
import {
  PythonNotFoundError,
  ensureVenv,
  pythonCandidates,
  resolvePython,
  venvPython,
} from "../../src/platform/python.mjs";

const okProbe = async () => ({ stdout: JSON.stringify({ major: 3, minor: 11, micro: 4, executable: "C:\\py\\python.exe", prefix: "x" }) + "\r\n", stderr: "", code: 0 });

test("Windows candidates prefer the venv, then py -3", () => {
  const list = pythonCandidates({ env: {}, home: "C:\\state", platform: "win32" });
  assert.deepEqual(list.map((c) => c.command), [
    join("C:\\state", "python-venv", "Scripts", "python.exe"),
    "py",
    "python3",
    "python",
  ]);
  assert.deepEqual(list[1].args, ["-3"]);
});

test("POSIX candidates prefer python3 and never use py", () => {
  const list = pythonCandidates({ env: {}, home: "/state", platform: "linux" });
  assert.deepEqual(list.map((c) => c.command), [
    join("/state", "python-venv", "bin", "python"),
    "python3",
    "python",
  ]);
});

test("an explicit interpreter wins over every default", () => {
  const list = pythonCandidates({ env: { MAGPIE_GPTFREE_PYTHON: "/opt/py/bin/python3.12" }, home: "/state", platform: "linux" });
  assert.equal(list[0].command, "/opt/py/bin/python3.12");
});

test("resolvePython skips broken candidates and reports why", async () => {
  const run = async (command) => {
    if (command === "python3") return okProbe();
    throw new CommandError("nope", { code: "ENOENT" });
  };
  const resolved = await resolvePython({ env: {}, home: "/state", run });
  assert.equal(resolved.command, "python3");
  assert.equal(resolved.info.minor, 11);
  assert.ok(resolved.attempts.length >= 1);
  assert.ok(resolved.attempts.every((a) => typeof a.error === "string"));
});

test("resolvePython raises a diagnostic error when nothing works", async () => {
  const run = async () => {
    throw new CommandError("missing", { code: "ENOENT" });
  };
  await assert.rejects(
    () => resolvePython({ env: {}, home: "/state", run }),
    (err) => {
      assert.ok(err instanceof PythonNotFoundError);
      assert.match(err.message, /未找到可用的 Python/);
      assert.ok(err.attempts.length >= 3);
      return true;
    },
  );
});

test("a Microsoft Store stub is named as such, not as a generic failure", async () => {
  const run = async (command) => {
    if (command === "python") {
      throw new CommandError("python exited with code 9009", {
        code: "EXIT_9009",
        stderr: "Python was not found; run without arguments to install from the Microsoft Store",
      });
    }
    throw new CommandError("missing", { code: "ENOENT" });
  };
  await assert.rejects(
    () => resolvePython({ env: {}, home: "/state", run }),
    (err) => err.attempts.some((a) => /Microsoft Store/.test(a.error)),
  );
});

test("ensureVenv creates the venv when the local interpreter is missing", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "gptfree-venv-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const target = venvPython(home);
  let created = false;
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, ...args]);
    if (command === target) {
      if (!created) throw new CommandError("missing venv", { code: "ENOENT" });
      return okProbe();
    }
    if (args.includes("venv")) {
      created = true;
      return { stdout: "", stderr: "", code: 0 };
    }
    return okProbe();
  };
  const result = await ensureVenv({ home, env: {}, run });
  assert.equal(result.python, target);
  assert.equal(result.created, true);
  assert.ok(calls.some((c) => c.includes("venv")));
});

test("ensureVenv reuses a working venv instead of recreating it", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "gptfree-venv-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, ...args]);
    return okProbe();
  };
  const result = await ensureVenv({ home, env: {}, run });
  assert.equal(result.created, false);
  assert.ok(!calls.some((c) => c.includes("venv")));
});
