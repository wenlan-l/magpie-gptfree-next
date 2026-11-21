# magpie-gptfree-next

Magpie「GPT号池」插件的模块化重构版。**Windows 与 Linux 同等支持**。

> 本仓库是 [yang0/magpie-gptfree](https://github.com/yang0/magpie-gptfree) 的重构分支，
> 协议层（`src/protocol/`、`python/`）保持上游实现，只重新组织了它外面的所有东西。
> 生产环境原本跑上游 `0.6.6`；本仓库的版本可以装回去，但**要先卸载旧版**——两者抢同一个
> provider id 与同一个 GUI 端口。

## 为什么重写

原插件在 Windows 上的问题不是零散 bug，是结构性的：

| 症状 | 根因 | 现在 |
|---|---|---|
| 侧边栏白板，只能重启 Magpie | 入口页把 iframe **直接导航**到 `127.0.0.1:37986`，只有一次 6 秒提示；导航失败连重试逻辑一起销毁 | 入口页变成状态机：先探 `/healthz`，失败留在原地显示原因并可重试 |
| 端口被占 → 整个插件加载失败 | `listen()` 抛错冒泡到插件加载，provider 报「no endpoint configured」 | 端口被占自动顺延（37986→37995），provider 照常可用；只有端口段全满才告警 |
| 中文回复出现 `�` | 子进程按系统代码页解码（中文 Windows 是 cp936）；流式输出用 `chunk.toString("utf-8")`，跨块的多字节字符被切断 | 全部走 `src/platform/proc.mjs`：强制 UTF-8，流式用 `StringDecoder` |
| 导入号池偶发失败 | 临时文件 + rename 撞上杀软 / OneDrive 的 EBUSY、EPERM | `writeAtomic` 对这些错误退避重试，最后降级为复制 |
| 重启后端口被上一轮占住 | `child.kill()` 只杀直接子进程，Python 留下的进程继续持有端口 | 按进程树回收（Windows `taskkill /T /F`），并用 `/healthz` 的 pid 自证只回收自己的 |
| 凭据保护形同虚设 | `chmod 0600` 在 Windows 上是空操作 | POSIX 用 0600，Windows 明确记录依赖用户目录 ACL，不再假装 |

## 结构

```
index.mjs            插件入口，只做 re-export（Magpie 按名字调用两个工厂）
src/platform/        OS 差异唯一出口：路径、Python 探测、进程、原子写、日志脱敏
src/core/            号池 / 凭据 / 额度 / 统计：纯逻辑，不碰 fs，不碰子进程
src/storage/         唯一允许落盘的非 platform 层：加密号池、统计
src/protocol/        上游协议实现，只装箱不改写（见 docs/PROTOCOL.md）
src/app/             Magpie 契约：插件工厂、GUI 侧车、生命周期、号池连接
src/gui/             前端，无构建步骤，原生 ES 模块
python/              上游 Python worker（一个请求一个进程）
diagnostics/         只读诊断包生成器
test/                node:test：platform / app / protocol 契约 / 上游回归（legacy）
baseline/            上游 v0.6.6 快照 + 固定的上游 commit，仅作对照
```

依赖方向只允许向下：`app → protocol → core → platform`。反向一律靠注入。

强制的不变量（`test/protocol/contract.test.mjs` 与 `scripts/check.mjs` 会拦）：

1. `platform/` 之外不得 import `node:os` / `node:child_process` / `node:net`。
2. `core/` 不得 import `node:fs` / `node:path`。
3. 所有子进程 `shell: false`，输出按 UTF-8 解码。
4. 所有持久化写入走 `writeAtomic`。
5. 日志入口强制脱敏（camelCase 的 `accessToken` 也认）。
6. **0 个 npm 依赖**——Windows 上一半的坑来自原生模块。

设计见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，协议层边界与升级流程见
[docs/PROTOCOL.md](docs/PROTOCOL.md)，阶段与验收标准见 [docs/ROADMAP.md](docs/ROADMAP.md)。

## 开发

Node ≥ 20，不需要 `npm install`。

```bash
npm run check         # 语法门禁（全部 .mjs）
npm test              # 单测：平台层 + 生命周期 + 侧车 HTTP + 协议契约 + 上游回归
npm run canary        # 协议金丝雀：零凭据，探测端点是否还活着
npm run upstream-diff # 上游有没有新提交，动了协议层还是前端
npm run diagnose      # 生成诊断包
```

CI（GitHub Actions）在 `ubuntu-latest` 与 `windows-latest` × Node 20/22 上跑同一套
`check → test → diagnostics --smoke`。Windows runner 上真的会跑 Python 探测、原子写和
worker 进程，不是「在 Linux 上看起来对」。

## 装进 Magpie

仓库是公开的，可以直接按仓库地址安装。**先卸载旧版 `magpie-gptfree`**，否则两个插件会
注册同一个 provider id、抢同一个端口。

装好后侧边栏应显示「正在连接本地服务」，随后进入号池页面；如果 25 秒内连不上，页面会
留在原地显示探测日志并提供重试按钮——不会再出现白板。

端口约定：`37986` 起，连续 10 个（`37986–37995`）。页面和服务端遍历同一段，不需要额外
发现通道。环境变量：`MAGPIE_GPTFREE_HOME`、`MAGPIE_GPTFREE_PYTHON`、`MAGPIE_GPTFREE_PORT`。

## 出问题时

```bash
node diagnostics/collect.mjs
```

生成 `gptfree-diagnostics-<时间>.json` 与 `.txt`。只读元数据——账号、Cookie、Token
一律不碰，`.txt` 可以直接贴出来。

## 许可

MIT，见 [LICENSE](LICENSE)。上游作者与第三方来源见 [NOTICE.md](NOTICE.md) 与
[python/THIRD_PARTY.md](python/THIRD_PARTY.md)。
