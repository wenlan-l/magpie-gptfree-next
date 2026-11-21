# 协议层（箱子）边界与升级流程

`src/protocol/` 与 `python/` 是**上游逆向实现**：sentinel、Turnstile、PoW、PKCE、
`picture_v2` 生图、Platform OAuth。这里的原则是**只装箱，不改写**——重写没有真实
账号与流量就无法验证正确性，只会在下一次协议变更时留下两份都错的实现。

## 箱子里有什么

| 文件 | 职责 | 外部入口 |
|---|---|---|
| `src/protocol/codex-pool.mjs` | Codex 后端：token 校验、模型发现、额度、`poolFetch` 转发 | `poolFetch`、`discoverPoolModels`、`refreshPoolAccount` |
| `src/protocol/chatgpt-web-text.mjs` | 网页端文本：模型表、请求解析、流式 worker、SSE 组装 | `runWebTextWorker`、`executeWebTextGeneration` |
| `src/protocol/chatgpt-web-image.mjs` | 网页端生图：`gpt-image-2`、模型目录、额度、`picture_v2` | `runWebImageWorker`、`executeWebImageGeneration` |
| `src/protocol/dsh-http-auth.mjs` | HTTP 密码 + TOTP 登录，Python 解释器解析 | `loginHTTPAccount`、`workerPython` |
| `python/*.py` | 上面三个适配器的 Python 侧，一个请求一个进程 | stdin JSON → stdout JSON |

协议层**可以**用 `src/platform/`（进程、UTF-8、原子写、日志），**不可以** import
`src/app/` 或 `src/gui/`。它不知道 Magpie 存在。

## 为什么必须有这道边界

上游每次改动都会同时动三样东西，只改一样就静默失败：

1. Python worker 的 stdin/stdout 报文（`action`、`type`、`error_code`）；
2. JS 侧对这些报文的解析与错误分类（401 → 换号，429 → 退避，其他 → 报错）；
3. 模型清单（免费号可用的模型是白名单，不是全部）。

所以 `test/protocol/contract.test.mjs` 锁的是这三样的**形状**，而不是协议细节：
导出面齐全、Python 产物与 `requirements.txt` 固定版本、帧字段存在、协议层不越过
platform 去 `spawn`、第三方声明覆盖每个 worker。

它拦不住「上游改了 sentinel 的算法」——那只能靠金丝雀发现。

## 上游升级流程

1. `node scripts/upstream-diff.mjs`（或等 CI 的 `upstream-watch` 开 issue）看上游
   动了哪些文件、是不是 `lib/` 或 `python/`。
2. 只看 diff，**不直接安装**。判断属于哪一类：
   - 报文/模型表变化 → 换箱子里对应文件，跑 `npm test`；
   - 依赖变化 → 更新 `python/requirements.txt`，版本必须钉死（`curl_cffi` 一换
     版本，TLS 指纹就变，整条网页链路开始 403）；
   - 纯 UI/文案 → 只挑与当前缺陷相关的部分。
3. `npm run check && npm test`，然后 `npm run canary` 确认端点还活着。
4. 在真实账号上做一次文本请求和一次生图请求（各一次，不要烧额度）。
5. 提交到 `baseline/upstream-<版本>/`（快照）+ 换箱子代码，两个提交分开，方便回滚。

## 金丝雀（`scripts/canary.mjs`）

零凭据部分每天跑，不需要账号、不烧额度：

- OIDC discovery 还在不在、字段有没有变；
- Codex 端点对匿名请求是否仍然返回 401（不是 404/HTML）；
- 网页端 `backend-api` 是否仍然要求鉴权。

设置 `MAGPIE_GPTFREE_CANARY_TOKEN` 才会追加一次真实文本请求（失败也只报错误码）。

网络受限的机器会得到 `skipped`，不是失败——这一点很重要：金丝雀用来发现**协议
漂移**，不用来判断「这台机器能不能上外网」。
