# 架构

## 分层

```
        ┌──────────────┐
        │  gui/ (web)  │  无构建，ES 模块，只认 HTTP + 明确的状态机
        └──────┬───────┘
               │ 同源 fetch，带会话能力令牌
        ┌──────▼───────┐
        │  adapters/   │  Magpie provider 注册、HTTP 侧车、ProtocolAdapter 实现
        └──────┬───────┘
        ┌──────▼───────┐
        │   core/      │  号池、凭据、额度、轮转：纯函数 + 显式依赖
        └──────┬───────┘
        ┌──────▼───────┐
        │ platform/    │  OS 差异唯一出口
        └──────┬───────┘
        ┌──────▼───────┐
        │ protocol/    │  上游 worker（Python），装箱，不改写
        └──────────────┘
```

依赖只允许向下。反向调用一律走注入（`core` 拿到的是回调，不是 `fs`）。

## 不变量

| 编号 | 规则 | 违反后果 |
|---|---|---|
| I1 | `platform/` 之外不出现 `node:os`、`node:child_process` | 平台 bug 散落全仓库 |
| I2 | `core/` 不出现 `node:fs`、`node:path` | 逻辑无法单测，Windows 路径判断满天飞 |
| I3 | 所有子进程输出按 UTF-8 解码，`shell: false` | 中文 Windows 乱码、参数被 cmd 重写 |
| I4 | 所有持久化写入走 `writeAtomic` | 断电/杀软导致 vault 半写 |
| I5 | 日志入口强制脱敏 | Cookie/Token 落盘 |
| I6 | 协议代码来自上游，只允许整体替换 | 无法跟随上游修复 |

## 侧边栏生命周期（P1 的核心修复）

问题根源：入口页把自身 iframe 导航到侧车，一旦目标不可达，页面变成浏览器错误页，
原文档里的任何重试逻辑都随之消失。

新模型：

```
idle ──start()──▶ probing ──ok──▶ ready ──▶ (serving)
                     │                │
                     │ 2s interval    │ 心跳失败
                     ▼                ▼
                  retrying ◀───────── degraded
                     │
                     └── 5 次失败 ──▶ failed(可读原因 + 手动重试)
```

要点：

1. 侧车由 supervisor 管理：启动即探测 `/healthz`，绑定失败自动换端口（37986 →
   37987 …）并回写 `plugins.json` 的 `port`。
2. 入口页不再 `location.replace` 到未验证的地址，先探测再导航；失败留在
   原文档内显示原因，重试按钮始终可用。
3. 侧车退出时按进程树回收（Windows `taskkill /T`），避免端口被上一轮占住。
4. 会话能力令牌持久化到 vault 同目录（0600 语义在 Windows 由 ACL 兜底），
   跨宿主重启仍可用。

## 存储

- 单写者：所有写操作排进一个队列，进程内串行。
- 原子替换：临时文件 + `fsync` + rename，Windows 上对 EPERM/EBUSY/EACCES 退避
  重试，最终降级为复制。
- 路径：统一过 `longPath()`，中文用户名 + 深层目录不再 ENOENT。
- 权限：POSIX 用 `0600`；Windows 记录明确事实——文件仅继承用户目录 ACL，并在
  文档中声明，而不是假装 `chmod` 生效。

## 协议适配器（P3）

```js
/**
 * @typedef {Object} ProtocolAdapter
 * @property {() => Promise<{version: string}>} handshake
 * @property {(account, opts) => Promise<Session>} login
 * @property {(session) => Promise<Session>} refresh
 * @property {(session, messages, opts) => AsyncIterable<Chunk>} chat
 * @property {(session, prompt, opts) => Promise<ImageResult>} image
 * @property {(session) => Promise<Quota>} quota
 */
```

适配器是唯一允许知道「ChatGPT 网页端长什么样」的地方。每个方法配一份真实响应
fixture，改动协议时先跑契约测试，再谈上层。

协议漂移的发现靠金丝雀（P5）：每天一次低成本 `handshake` + `chat`，按错误码
分类记录。GitHub 上的上游提交只是提前量，不是唯一信号。
