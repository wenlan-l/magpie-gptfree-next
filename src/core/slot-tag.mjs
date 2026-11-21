/**
 * Deterministic per-account slot identifiers.
 *
 * A slot tag is a truncated SHA-256 of the normalised email: stable across
 * restarts, unique per account, and non-reversible enough that logs and the
 * Magpie auth store never carry a raw address. Shared by core, storage and
 * protocol — hence its own module rather than a helper inside the app layer.
 */
import { createHash } from "node:crypto";
import { safeAccountName } from "./credentials.mjs";

export function normalizePoolEmail(email) {
  return String(email || "").trim().toLowerCase();
}

export function accountSlotTag(email) {
  const norm = normalizePoolEmail(email);
  return "s" + createHash("sha256").update(norm).digest("hex").slice(0, 10);
}

export function formatAccountSlotLabel(email) {
  const norm = normalizePoolEmail(email);
  if (!norm || !norm.includes("@")) return "GPT号池 账号";
  const tag = accountSlotTag(norm);
  return `${safeAccountName(norm)} · ${tag.slice(1, 9)}`;
}
