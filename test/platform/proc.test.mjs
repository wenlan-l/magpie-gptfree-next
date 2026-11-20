import assert from "node:assert/strict";
import test from "node:test";
import { CommandError, killTree, runCommand } from "../../src/platform/proc.mjs";

const node = process.execPath;

test("captures UTF-8 output without mangling non-ASCII", async () => {
  const { stdout } = await runCommand(node, ["-e", "process.stdout.write('号池 ✓ 完成')"]);
  assert.equal(stdout, "号池 ✓ 完成");
});

test("passes arguments containing spaces and quotes literally (no shell)", async () => {
  const { stdout } = await runCommand(node, ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "a b", 'c"d', "$HOME"]);
  assert.deepEqual(JSON.parse(stdout), ["a b", 'c"d', "$HOME"]);
});

test("rejects with the exit code and captured stderr", async () => {
  await assert.rejects(
    () => runCommand(node, ["-e", "process.stderr.write('boom');process.exit(3)"]),
    (err) => {
      assert.ok(err instanceof CommandError);
      assert.equal(err.code, "EXIT_3");
      assert.match(err.stderr, /boom/);
      return true;
    },
  );
});

test("times out and kills the child", async () => {
  const started = Date.now();
  await assert.rejects(
    () => runCommand(node, ["-e", "setTimeout(() => {}, 30000)"], { timeout: 400 }),
    (err) => {
      assert.equal(err.code, "ETIMEDOUT");
      assert.equal(err.timedOut, true);
      return true;
    },
  );
  assert.ok(Date.now() - started < 10_000, "should return shortly after the deadline");
});

test("reports a missing binary instead of throwing synchronously", async () => {
  await assert.rejects(
    () => runCommand("definitely-not-a-binary-gptfree", []),
    (err) => err instanceof CommandError && err.code === "ENOENT",
  );
});

test("killTree is a no-op for an already exited child", async () => {
  const child = (await import("node:child_process")).spawn(node, ["-e", "0"], { stdio: "ignore" });
  await new Promise((resolve) => child.once("close", resolve));
  assert.doesNotThrow(() => killTree(child));
});
