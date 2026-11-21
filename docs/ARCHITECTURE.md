# 架构

目标不是「把代码分文件夹」，而是让每一类 Windows 故障只能出现在一个地方。

```
                 ┌──────────────────────────────┐
                 │ src/gui/   页面（无构建步骤） │
                 └──────────────┬───────────────┘
                                │ HTTP（loopback + 一次性会话令牌）
                 ┌──────────────▼───────────────┐
                 │ src/app/   宿主契约 + 侧车   │
                 └──────────────┬───────────────┘
                 ┌──────────────▼───────────────┐
                 │ src/protocol/  上游协议（箱子）│
                 └──────────────┬───────────────┘
                 ┌──────────────▼───────────────┐
                 │ src/storage/  凭证与统计落盘  │
                 └──────────────┬───────────────┘
                 ┌──────────────▼───────────────┐
                 │ src/core/   纯逻辑、无 IO     │
                 └──────────────┬───────────────┘
                 ┌──────────────▼───────────────┐
                 │ src/platform/  操作系统唯一出口│
                 └──────────────────────────────┘
```

依赖只能向下。`test/layering.test.mjs` 每次跑测试都会重新验证这一点，文档与代码
不一致时先信测试。

## 各层职责

**platform** — 唯一允许碰 `node:os` / `node:child_process` / `node:net` 的地方。
`paths.mjs`（数据目录、Windows 长路径前缀）、`python.mjs`（解释器探测：跳过 Microsoft
Store 的假 `python.exe`、venv 创建、pip 安装）、`proc.mjs`（UTF-8 强制解码、按进程树回
收、流式逐行）、`atomic-file.mjs`（EBUSY/EPERM 退避重试、独占创建）、`log.mjs`（入口
强制脱敏）、`file-dialog.mjs`（原生文件选择器）。

**core** — 纯函数与数据结构：账号行解析、JWT 过期判断、代理 URL 校验、TOTP、slot
标签、模型白名单。没有 `fs`、没有 `path`，因此可以在任何平台上用普通单测覆盖。

**storage** — 唯一允许 `fs` 的非 platform 层：加密号池（AES-256-GCM，密钥
`master.key` 独占创建）、额度与生图统计（按 slot 标签索引，绝不写邮箱或 token）。

**protocol** — 上游逆向实现，只装箱不改写。边界、报文契约、升级流程见
[PROTOCOL.md](PROTOCOL.md)。它不知道 Magpie 存在。

**app** — Magpie 契约：插件工厂（`GPTFreeGuiPlugin` / `GPTFreePoolPlugin`）、GUI 侧车
（HTTP 服务、会话令牌、`/healthz`）、生命周期（端口段、陈旧进程回收）、号池与
Magpie 账号的同步。

**gui** — 原生 ES 模块，无打包、无框架。`entry.html` 只负责「把侧边栏画出来并连上侧
车」，真正的内容页是 `dashboard.html`。

## 不变量

| # | 规则 | 为什么 | 谁在拦 |
|---|---|---|---|
| I1 | `platform/` 之外不得 import `node:os` / `child_process` / `net` | 这三样是 Windows 差异的全部来源 | `test/layering.test.mjs` |
| I2 | `core/` 不得 import `node:fs` / `node:path` | 纯逻辑才能被两个平台同样的单测覆盖 | 同上 |
| I3 | 依赖只能向下 | 反向依赖会把平台细节漏到协议层 | 同上 |
| I4 | 子进程 `shell: false` | shell 引号在 Windows 上解释不同 | 同上 |
| I5 | 持久化写入必须走 `writeAtomic` | 杀软/OneDrive 会让 rename 抛 EPERM | 同上 |
| I6 | `platform/` 之外不得调用 `chmod` | Windows 上静默无效，制造虚假安全感 | 同上 |
| I7 | 日志入口强制脱敏 | 上游把完整 URL 写进巡检日志 | `test/platform/log.test.mjs` |

## 侧边栏如何连接侧车

Magpie 的插件页禁止跨源探测和嵌套 iframe。入口页等待 `magpie.ready`，然后在原插件 iframe 内导航。

- 网页端将 `magpie.service` 相对于入口页解析，并导航至代理根路径。Magpie 在该路径启动插件宿主，并在侧车尚未就绪时重试。侧车返回控制台页面，页面通过同一代理访问资源和 API。
- 桌面端没有代理地址时，入口页访问配置端口的 `/ui`。配置端口被其他程序占用时侧车直接报错，不换端口：宿主代理固定指向该端口，换端口只会让侧边栏显示出占用者的页面。

`/healthz` 返回服务标识、PID、端口和版本，供宿主机诊断与陈旧进程回收使用。

## 陈旧进程回收的判定

只有同时满足三条才会被回收，否则一律只记日志：

1. `/healthz` 的 `service` 字段是我们的 marker；
2. endpoint 文件里的 `pid` 与该进程一致；
3. 该 pid 仍存活。

这样既不会误杀「别人的 37986」，也不会因为上一轮崩溃留下的文件而阻塞启动。

## 安全模型

- 号池凭证只存在本机加密文件里，`master.key` 独占创建（已存在则绝不覆盖）；不是硬件
  级密钥库，同一 OS 用户可读——不假装更强。
- Magpie 的 plugin-auth 存储里只放掩码标签与 slot 标签（`s<sha256 前 10 位>`），不放
  邮箱、密码、token。
- GUI 服务只绑 `127.0.0.1`，每个页面一个一次性会话令牌，`Origin` 与 `Host` 都校验。
- `/healthz` 是唯一无鉴权路由，只回版本/pid/端口，不读 vault、不触发任何账号操作。
- 日志与诊断包在入口脱敏；诊断包只读元数据。

## 已知的「不属于我们」

`src/protocol/` 与 `python/` 是上游逆向实现，本仓库不试图改进它的正确性，只保证它的
输入输出形状稳定。协议变更的处理流程见 [PROTOCOL.md](PROTOCOL.md)。
