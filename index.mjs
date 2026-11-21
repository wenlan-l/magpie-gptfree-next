/**
 * GPT号池 — Magpie plugin entry.
 *
 * Magpie loads this file and calls the two exported plugin factories by name
 * (see package.json#magpie). Implementation lives under src/ in dependency
 * order: platform -> core -> protocol -> app. Keep this file free of logic so
 * a host upgrade can never be blocked by it.
 */
export { GPTFreeGuiPlugin, GPTFreePoolPlugin } from "./src/app/plugin.mjs";
