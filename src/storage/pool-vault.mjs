/**
 * Owner-local, encrypted token pool. The key stays in the owner's home
 * directory; it is NOT a hardware-backed OS keychain. A compromise of the
 * same OS user can read both files, so we never claim otherwise.
 *
 * Never persist id_token or refresh_token acquired by a Codex sign-in that
 * Magpie's native importer may rotate. Pool mode stores only access tokens
 * plus the owner-provided email/password/TOTP needed for browser reauth.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { writeAtomic, writeExclusive } from "../platform/atomic-file.mjs";
import { ensureDir, pluginHome } from "../platform/paths.mjs";

const NAME = "pool.enc.json";
const KEYFILE = "master.key";
const FORMAT = 1;
const MAX_RECORDS = 1000;

export function poolDir() {
  return pluginHome();
}

async function machineKey(root) {
  const file = join(root, KEYFILE);
  // Exclusive create: whoever wins writes the key, everyone else reads it.
  await writeExclusive(file, randomBytes(32));
  const key = await readFile(file);
  if (key.length !== 32) throw new Error("本地号池加密密钥无效；拒绝读取凭证");
  return key;
}

async function readUnlocked(root, key) {
  let file;
  try { file = await readFile(join(root, NAME), "utf8"); }
  catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  let blob;
  try { blob = JSON.parse(file); }
  catch { throw new Error("本地号池数据文件无法解析"); }
  if (blob?.version !== FORMAT || typeof blob?.iv !== "string" ||
      typeof blob?.tag !== "string" || typeof blob?.data !== "string")
    throw new Error("本地号池数据文件格式无效");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(blob.iv, "base64"));
    decipher.setAuthTag(Buffer.from(blob.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(blob.data, "base64")), decipher.final(),
    ]);
    const records = JSON.parse(plaintext.toString("utf8"));
    if (!Array.isArray(records) || records.length > MAX_RECORDS)
      throw new Error("invalid size");
    return records;
  } catch {
    throw new Error("本地号池解密失败；检查当前系统用户/密钥及文件完整性");
  }
}

async function storeUnlocked(root, key, rows) {
  if (rows.length > MAX_RECORDS) throw new Error("号池账号数量超过 1000");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([
    cipher.update(JSON.stringify(rows), "utf8"), cipher.final(),
  ]);
  const blob = JSON.stringify({
    version: FORMAT, iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"), data: ct.toString("base64"),
  });
  // Atomic replace with EBUSY/EPERM retries: on Windows the vault file is a
  // favourite target for indexers and AV scanners, which upstream tripped on.
  await writeAtomic(join(root, NAME), blob, { mode: 0o600 });
}

// The lock is advisory for this process; importing in more than one CLI
// simultaneously is not supported, and the README warns against it.
let pending = Promise.resolve();
async function exclusive(work) {
  const run = pending.then(work, work);
  pending = run.catch(() => {});
  return run;
}

export async function listPool({ root = poolDir() } = {}) {
  await ensureDir(root);
  return readUnlocked(root, await machineKey(root));
}

export async function upsertPool(record, { root = poolDir() } = {}) {
  return exclusive(async () => {
    if (!record || typeof record.email !== "string" ||
        typeof record.password !== "string" || typeof record.totp !== "string" ||
        typeof record.accessToken !== "string" || !record.accessToken)
      throw new Error("号池记录缺少账号凭证");
    await ensureDir(root);
    const key = await machineKey(root);
    const rows = await readUnlocked(root, key);
    const item = {
      email: record.email.trim().toLowerCase(),
      password: record.password,
      totp: record.totp,
      accessToken: record.accessToken,
      updatedAt: new Date().toISOString(),
    };
    const i = rows.findIndex((r) => r.email === item.email);
    if (i < 0) rows.push(item);
    else rows[i] = item;
    await storeUnlocked(root, key, rows);
    return { updated: i >= 0, total: rows.length };
  });
}

export async function removePool(email, { root = poolDir() } = {}) {
  return exclusive(async () => {
    await ensureDir(root);
    const key = await machineKey(root), rows = await readUnlocked(root, key);
    const kept = rows.filter((r) => r.email !== String(email).trim().toLowerCase());
    if (kept.length !== rows.length) await storeUnlocked(root, key, kept);
    return { removed: rows.length - kept.length, total: kept.length };
  });
}
