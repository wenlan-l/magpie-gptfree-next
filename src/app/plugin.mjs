/**
 * Magpie plugin surface: one GUI host plugin and one multi-account provider.
 *
 * This file is the whole public contract with Magpie. Everything else lives
 * under src/ in dependency order: platform -> core -> protocol -> app.
 * Keep exported names and the shapes in package.json#magpie stable; Magpie
 * resolves them by name.
 */
import { CODEX_BASE, discoverPoolModels, poolFetch } from "../protocol/codex-pool.mjs";
import { GUI_PORT, startGuiServer } from "./gui-service.mjs";
import { createPoolConnector, POOL_PRODUCT_LABEL, POOL_PROVIDER } from "./pool-connection.mjs";
import { nativeImportMethod } from "./provider-native-signin.mjs";
import { rmSync } from "node:fs";
import { endpointFile } from "./lifecycle.mjs";

let sharedClient = null;
let sharedConnector = null;
let sharedActiveKey = null;
let exitHookInstalled = false;

function ensurePoolConnector(ctx) {
  if (typeof ctx?.magpie?.account === "function") {
    sharedActiveKey = () => String(ctx.magpie.account(POOL_PROVIDER) || "");
  }
  if (typeof ctx?.client?.auth?.set === "function" &&
      typeof ctx?.client?.auth?.remove === "function") {
    if (!sharedConnector || sharedClient !== ctx.client) {
      sharedClient = ctx.client;
      sharedConnector = createPoolConnector(ctx.client, {
        getActiveKey: () => (sharedActiveKey ? sharedActiveKey() : ""),
      });
    }
  }
  return sharedConnector;
}

function slotFromAuth(auth) {
  const slot = auth?.metadata?.poolSlot;
  return typeof slot === "string" && /^s[0-9a-f]{6,16}$/i.test(slot) ? slot : "";
}

/** A log that cannot be written must never stop the plugin from loading. */
async function log(ctx, level, message) {
  try {
    await ctx?.client?.app?.log?.({ body: { service: "gptfree", level, message } });
  } catch {
    /* host logging is best-effort */
  }
}

export const GPTFreeGuiPlugin = async (ctx, options) => {
  const raw = options?.port ?? GUI_PORT;
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw new Error("GPT号池 GUI: invalid service port");

  const connection = ensurePoolConnector(ctx) || createPoolConnector(ctx.client);

  if (!exitHookInstalled) {
    exitHookInstalled = true;
    // Best-effort: the endpoint file only helps the next host reclaim a port.
    try {
      process.once("exit", () => {
        try { rmSync(endpointFile(), { force: true }); } catch { /* ignore */ }
      });
      process.once("uncaughtException", (error) => {
        try { rmSync(endpointFile(), { force: true }); } catch { /* ignore */ }
        throw error;
      });
    } catch {
      /* ignore */
    }
  }

  try {
    const service = await startGuiServer({
      port,
      onPoolChange: () => connection.sync(),
    });
    if (service.portInfo?.reclaimed) {
      await log(ctx, "info", `GPT号池 GUI 已监听 127.0.0.1:${service.port}`);
    }
  } catch (error) {
    // The provider side does not need the GUI. Failing the whole plugin load
    // left the user with "GPT号池 has no endpoint configured" until the port
    // was freed by hand — worse than a disabled sidebar with a reason.
    await log(ctx, "warn",
      "GPT号池 GUI 服务未能启动（" + String(error?.message || error) +
      "）；号池 provider 仍然可用，侧边栏在端口释放前不可用");
  }

  try {
    await connection.sync();
  } catch {
    await log(ctx, "warn",
      "无法恢复本地号池状态；请打开侧边栏检查号池存储");
  }
  return {};
};

/**
 * Separate, multi-account access-token pool mode.
 * Every admitted vault account is synchronized to its own Magpie Providers
 * account row, allowing individual selection, preferred routing and failover.
 */
export const GPTFreePoolPlugin = async (ctx = {}) => {
  const connector = ensurePoolConnector(ctx);
  return {
    config: async (cfg) => {
      cfg.provider ??= {};
      cfg.provider[POOL_PROVIDER] ??= {
        name: POOL_PRODUCT_LABEL,
        npm: "@ai-sdk/openai",
        api: CODEX_BASE,
        models: {},
      };
    },
    auth: {
      provider: POOL_PROVIDER,
      maxConcurrency: 2,
      // Native Magpie prompt & file chooser; never opens an external website.
      // Multi-account management stays enabled so every pooled account gets its
      // own toggleable row in Magpie Providers.
      methods: [nativeImportMethod({
        ...(connector ? { server: () => startGuiServer({ port: GUI_PORT, onPoolChange: () => sharedConnector?.sync() }) } : {}),
        syncPool: () => sharedConnector?.sync(),
        claimSlotKey: (slot, key) => sharedConnector?.claimKey(slot, key),
        activeKey: () => (sharedActiveKey ? sharedActiveKey() : ""),
      })],
      async loader(getAuth) {
        const auth = await getAuth();
        if (auth?.type !== "api") return {};
        const preferredSlot = slotFromAuth(auth);
        return {
          baseURL: CODEX_BASE,
          apiKey: auth.key,
          fetch: (input, init) => poolFetch(input, init, { preferredSlot }),
        };
      },
    },
    provider: {
      id: POOL_PROVIDER,
      async models(_provider, { auth } = {}) {
        if (auth?.type !== "api") return {};
        return discoverPoolModels({ preferredSlot: slotFromAuth(auth) });
      },
    },
  };
};
