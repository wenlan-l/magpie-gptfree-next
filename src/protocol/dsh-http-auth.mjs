/**
 * Standalone DSH-compatible HTTP password + TOTP authentication adapter.
 * No DSH service, no Playwright and no Codex CLI process.
 *
 * The Python worker was adapted from yang0/chatgpt2api-dsh and retains the
 * Platform OAuth client and curl_cffi request flow. Platform tokens are NOT
 * assumed to be accepted by the Codex backend: callers must validate them
 * against the actual model endpoint before placing accounts in the pool.
 *
 * Python discovery, venv creation and pip installs live in src/platform so
 * that the Windows quirks (Store stub `python.exe`, `py -3`, Scripts\ layout)
 * are solved once instead of per module.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "../platform/proc.mjs";
import { pluginHome } from "../platform/paths.mjs";
import { ensureVenv, installRequirements } from "../platform/python.mjs";

const PYDIR = join(dirname(fileURLToPath(import.meta.url)), "../../python");
const WORKER = join(PYDIR, "auth_worker.py");
const REQUIREMENTS = join(PYDIR, "requirements.txt");

/** Worker output is UTF-8 by contract: the platform runner decodes it as such. */
async function run(command, args, { input = "", timeout = 120000, signal } = {}) {
  const result = await runCommand(command, args, { input, timeout, signal });
  return result.stdout;
}

let ready = null;

async function prepare() {
  const home = pluginHome();
  const venv = await ensureVenv({ home });
  try {
    await run(venv.python, ["-c", "import curl_cffi"], { timeout: 15000 });
  } catch {
    await installRequirements({ home, requirements: REQUIREMENTS });
    await run(venv.python, ["-c", "import curl_cffi"], { timeout: 15000 });
  }
  return venv.python;
}

/**
 * Resolves to the venv interpreter that can run the auth worker. Failures are
 * not cached, so a transient pip/network error can be retried from the GUI.
 */
export function workerPython() {
  if (!ready) {
    ready = prepare().catch((error) => {
      ready = null;
      throw error;
    });
  }
  return ready;
}

export function normalizeWorkerResult(raw) {
  let parsed;
  try { parsed = JSON.parse(String(raw)); }
  catch { throw new Error("DSH HTTP 登录后端返回无效数据"); }
  if (parsed?.ok !== true)
    throw new Error("DSH HTTP 授权未完成（" + String(parsed?.error || "auth_failed").slice(0, 80) + "）");
  const accessToken = String(parsed.access_token || "");
  if (!accessToken || accessToken.length > 16384)
    throw new Error("HTTP 登录成功，但没有返回可用 access_token");
  return {
    access: accessToken,
    refresh: String(parsed.refresh_token || ""),
    id: String(parsed.id_token || ""),
  };
}

export async function loginHTTPAccount(account, { signal, proxy = "",
  worker = run, python = workerPython } = {}) {
  if (!account?.email || !account?.password)
    throw new Error("HTTP 登录需要邮箱和密码");
  if (signal?.aborted) throw new Error("HTTP 登录已取消");
  const command = await python();
  // One account per isolated worker so a failed account does not invalidate
  // a whole TXT batch. Input is never an argv argument or a log message.
  const output = await worker(command, [WORKER], {
    input: JSON.stringify({
      action: "authenticate", email: account.email, password: account.password,
      totp_secret: account.totp || "", proxy,
    }),
    timeout: 180000, signal,
  });
  const tokens = normalizeWorkerResult(output);
  return { tokens, email: account.email };
}
