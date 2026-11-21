/**
 * Protocol canary: is the ChatGPT/OpenAI surface still shaped the way the
 * vendored workers expect?
 *
 * The zero-credential checks run everywhere and burn nothing. A real text
 * request only runs when MAGPIE_GPTFREE_CANARY_TOKEN is set, and the token is
 * never printed — not in the report, not in an error path.
 *
 * Exit codes: 0 = healthy or skipped (no network), 1 = drift detected.
 */
import { runWebTextWorker } from "../src/protocol/chatgpt-web-text.mjs";

const OIDC = "https://auth.openai.com/.well-known/openid-configuration";
const CODEX_MODELS = "https://chatgpt.com/backend-api/codex/models";
const WEB_ME = "https://chatgpt.com/backend-api/me";
const TIMEOUT = 15_000;

const checks = [];

const record = (name, status, detail) => {
  checks.push({ name, status, detail });
  const mark = status === "ok" ? "ok  " : status === "skipped" ? "skip" : "FAIL";
  console.log(`${mark} ${name}${detail ? ` — ${detail}` : ""}`);
};

async function get(url, { headers = {}, accept = "application/json" } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const res = await fetch(url, {
      headers: { accept, ...headers },
      redirect: "manual",
      signal: controller.signal,
    });
    const text = await res.text().catch(() => "");
    return {
      status: res.status,
      text,
      location: res.headers.get("location") || "",
      mitigated: res.headers.get("cf-mitigated") || "",
      server: res.headers.get("server") || "",
    };
  } finally {
    clearTimeout(timer);
  }
}

const networkDown = (error) =>
  /fetch failed|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|aborted|network/i.test(String(error?.message || error));

async function checkOidc() {
  const name = "auth.openai.com OIDC discovery";
  try {
    const { status, text, mitigated } = await get(OIDC);
    if (status !== 200) {
      // A WAF/geo block looks identical to a protocol change if you only read
      // the status code. Distinguish them: 403/429/503 with an HTML body or a
      // cf-mitigated header is the network, not the protocol.
      if ([403, 429, 503].includes(status) && (mitigated || /<html|<!doctype/i.test(text.slice(0, 200)))) {
        return record(name, "skipped", `HTTP ${status}，疑似被 WAF 或网络策略拦截（不是协议漂移）`);
      }
      return record(name, "fail", `HTTP ${status}`);
    }
    let doc;
    try {
      doc = JSON.parse(text);
    } catch {
      return record(name, "fail", "响应不是 JSON（可能被拦截或已改版）");
    }
    const missing = ["issuer", "authorization_endpoint", "token_endpoint"]
      .filter((key) => typeof doc[key] !== "string" || !doc[key]);
    if (missing.length) return record(name, "fail", `缺少字段 ${missing.join(", ")}`);
    record(name, "ok", doc.issuer);
  } catch (error) {
    record(name, networkDown(error) ? "skipped" : "fail", String(error?.message || error));
  }
}

/** An anonymous request must be rejected with 401: 404/HTML means the path moved. */
async function checkAuthWall(name, url) {
  try {
    const { status, text, location, mitigated } = await get(url);
    if (status === 401 || status === 403) return record(name, "ok", `HTTP ${status}（仍要求鉴权）`);
    if (status === 200) return record(name, "fail", "匿名请求得到 200：端点不再要求鉴权");
    if (status === 404 || status === 308) {
      return record(name, "fail", `HTTP ${status}${location ? ` → ${location}` : ""}（端点已迁移）`);
    }
    if (mitigated || (/<!doctype html|<html/i.test(text.slice(0, 200)) && [403, 429, 503, 520, 522].includes(status))) {
      return record(name, "skipped", `HTTP ${status}，疑似被 WAF 或网络策略拦截`);
    }
    if (/<!doctype html|<html/i.test(text.slice(0, 200))) {
      return record(name, "fail", `HTTP ${status}，返回 HTML（被拦截或改版）`);
    }
    record(name, "warn", `HTTP ${status}`);
  } catch (error) {
    record(name, networkDown(error) ? "skipped" : "fail", String(error?.message || error));
  }
}

async function checkTextProbe() {
  const name = "真实文本请求（一个 token）";
  const token = process.env.MAGPIE_GPTFREE_CANARY_TOKEN || "";
  if (!token) return record(name, "skipped", "未设置 MAGPIE_GPTFREE_CANARY_TOKEN");
  const started = Date.now();
  try {
    const result = await runWebTextWorker(
      { model: "gpt-5.6-luna", messages: [{ role: "user", content: "ping" }], access_token: token },
      { timeout: 90_000 },
    );
    if (result?.ok) {
      // Only the shape of the answer is reported, never its text.
      return record(name, "ok", `${Date.now() - started}ms，回复 ${String(result.text || "").length} 字符`);
    }
    const code = result?.error_code || "unknown";
    const fatal = ["unauthorized", "missing_token", "token_invalid"].includes(code);
    record(name, fatal ? "fail" : "warn", `${code}：${String(result?.error || "").slice(0, 160)}`);
  } catch (error) {
    record(name, networkDown(error) ? "skipped" : "fail", String(error?.message || error));
  }
}

await checkOidc();
await checkAuthWall("codex 后端鉴权墙", CODEX_MODELS);
await checkAuthWall("网页端 backend-api 鉴权墙", WEB_ME);
await checkTextProbe();

const tally = checks.reduce((acc, check) => {
  acc[check.status] = (acc[check.status] || 0) + 1;
  return acc;
}, {});
const failed = tally.fail || 0;
const report = { checkedAt: new Date().toISOString(), platform: process.platform, node: process.version, tally, checks };
console.log(JSON.stringify(report, null, 2));

// The CI workflow uploads this file; keep it in the working directory only.
try {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(process.env.CANARY_OUT || "canary-report.json", JSON.stringify(report, null, 2) + "\n");
} catch {
  /* a read-only working directory is not a canary failure */
}

if (failed) {
  console.error(`\n协议漂移告警：${failed} 项失败。先看 docs/PROTOCOL.md 的升级流程，不要直接换实现。`);
  process.exit(1);
}
console.log("\n金丝雀通过。");
