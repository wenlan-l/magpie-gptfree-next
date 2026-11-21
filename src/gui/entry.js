/**
 * Sidebar bootstrap — the part that used to white-board.
 *
 * Upstream navigated the plugin frame straight to the loopback service and set
 * one 6s timer as a fallback. Navigating away destroyed that timer, so a
 * service that was slow, restarting or shadowed by a stale process left an
 * unrecoverable error page inside the sidebar.
 *
 * Here the frame is never navigated. A nested iframe is pointed at the service
 * only after an <img> probe proves it is listening, and the service itself
 * posts a "ready" message once its own scripts run. If none of that happens the
 * bootstrap document stays alive with a retry button and a probe log.
 */
const SPAN = 10;
const PROBE_TIMEOUT = 800;
const READY_TIMEOUT = 8000;
const SWEEP_PAUSE = 400;
const TOTAL_BUDGET = 25000;

const $ = (id) => document.getElementById(id);
const frame = $("app");
const boot = $("boot");
const state = $("state");
const detail = $("detail");
const retry = $("retry");

let action = "";
let base = "";
let ready = false;
let attempt = 0;

try {
  if (typeof magpie.onAction === "function") {
    magpie.onAction((data) => {
      if (typeof data?.id === "string" && ["batch-import", "manage-pool"].includes(data.id))
        action = data.id;
    });
  }
} catch {
  /* page opened outside Magpie: the pool UI still works standalone */
}

/**
 * An <img> load is the only cross-origin readiness check a sandboxed page can
 * make: fetch() is blocked by Magpie's CSP, and a failed image load is silent.
 */
function probe(target) {
  return new Promise((resolve) => {
    const img = new Image();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      img.onload = img.onerror = null;
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), PROBE_TIMEOUT);
    img.onload = () => finish(true);
    img.onerror = () => finish(false);
    img.src = target + "healthz.png?probe=" + Date.now() + "-" + Math.random().toString(36).slice(2);
  });
}

function candidates(preferred) {
  const list = [];
  if (typeof magpie !== "undefined" && typeof magpie.service === "string" && magpie.service) {
    try {
      list.push(new URL(magpie.service).href.replace(/\/?$/, "/"));
    } catch {
      /* ignore a malformed host-provided base */
    }
  }
  for (let i = 0; i < SPAN; i++) {
    const port = preferred + i;
    if (port > 65535) break;
    list.push("http://127.0.0.1:" + port + "/");
  }
  return list;
}

function setState(text) {
  state.textContent = text;
}

async function resolveBase(preferred) {
  const list = candidates(preferred);
  const tried = [];
  const deadline = Date.now() + TOTAL_BUDGET;
  while (Date.now() < deadline) {
    attempt += 1;
    for (const candidate of list) {
      if (await probe(candidate)) return { base: candidate, tried };
      tried.push(candidate.replace(/^https?:\/\//, "").replace(/\/$/, ""));
    }
    setState("正在启动本地服务…（第 " + attempt + " 次尝试）");
    await new Promise((resolve) => setTimeout(resolve, SWEEP_PAUSE));
  }
  const error = new Error("本地服务未响应");
  error.tried = tried;
  throw error;
}

function showFailure(message, tried) {
  setState(message);
  retry.hidden = false;
  detail.classList.add("on");
  const unique = [...new Set(tried || [])];
  detail.textContent = unique.length
    ? "已探测：" + unique.join("、") + "\n均未返回健康检查响应。"
    : "未能获得可用的本地端口。";
}

function attach(target, pendingAction) {
  const url = new URL("ui", target);
  if (pendingAction) url.hash = "action=" + pendingAction;
  ready = false;
  frame.hidden = false;
  frame.src = url.href;
  const started = Date.now();
  const check = setInterval(() => {
    if (ready) return clearInterval(check);
    if (Date.now() - started > READY_TIMEOUT) {
      clearInterval(check);
      showFailure("页面已加载，但本地服务没有回应。可重新连接，或检查插件是否被 Magpie 暂停。", [target]);
    }
  }, 400);
}

async function main() {
  boot.hidden = false;
  retry.hidden = true;
  detail.classList.remove("on");
  setState("正在连接本地服务…");
  attempt = 0;

  let preferred = 37986;
  try {
    if (typeof magpie !== "undefined" && magpie.ready) {
      await magpie.ready;
      const options = await magpie.options.get();
      const configured = Number(options?.port);
      if (Number.isSafeInteger(configured) && configured > 0 && configured < 65536) preferred = configured;
    }
  } catch {
    /* defaults are fine: the probe range starts at 37986 */
  }

  try {
    const found = await resolveBase(preferred);
    base = found.base;
    attach(base, action);
  } catch (error) {
    showFailure("本地服务没有启动。插件可能刚被 Magpie 重新加载，稍后重试即可。", error.tried);
  }
}

// The service proves readiness itself; only then is the overlay removed.
window.addEventListener("message", (event) => {
  if (event.source !== frame.contentWindow) return;
  if (event.data?.type !== "gptfree:ready") return;
  ready = true;
  boot.hidden = true;
});

retry.addEventListener("click", () => {
  frame.hidden = true;
  frame.removeAttribute("src");
  main();
});

// A reload can also mean "Magpie restarted the plugin host": retry on focus.
window.addEventListener("focus", () => {
  if (!ready) return;
  // Cheap liveness re-check: if the service died while hidden, surface it.
  probe(base).then((ok) => {
    if (ok) return;
    ready = false;
    boot.hidden = false;
    showFailure("本地服务已停止，请重新连接。", [base]);
  });
});

main();
