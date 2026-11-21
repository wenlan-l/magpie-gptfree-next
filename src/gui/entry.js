// Magpie's sandbox blocks fetches and child frames on the bootstrap page.
// Navigate the existing frame to the host's page-service proxy on web, or
// directly to the configured loopback service on desktop.
(async () => {
  const state = document.getElementById("state");
  const retry = document.getElementById("retry");
  retry.addEventListener("click", () => location.reload());
  let action = "";
  try {
    magpie.onAction?.(({ id } = {}) => {
      if (["batch-import", "manage-pool"].includes(id)) action = id;
    });
    await magpie.ready;
    const service = magpie.service;
    let target;
    if (service) {
      // The proxy root also starts the plugin host and retries if it is cold.
      target = new URL(service, location.href);
      if (!["http:", "https:"].includes(target.protocol)) throw new Error("Invalid service URL");
    } else {
      const options = await magpie.options.get();
      const port = Number(options?.port ?? 37986);
      if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("Invalid service port");
      target = new URL(`http://127.0.0.1:${port}/ui`);
    }
    if (action) target.hash = "action=" + action;
    setTimeout(() => {
      state.textContent = "本地服务尚未连接。请确认插件已启用，然后重试。";
      retry.hidden = false;
    }, 6000);
    location.replace(target.href);
  } catch {
    state.textContent = "无法连接本地服务。请检查插件是否已启用，以及端口设置是否有效。";
    retry.hidden = false;
  }
})();
