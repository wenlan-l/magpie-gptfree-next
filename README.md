# magpie-gptfree-next

Magpie「GPT号池」插件的模块化重构版。**Windows 与 Linux 同等支持**。

> 状态：**P0 骨架，尚不可作为插件安装。** 现在只有平台层、诊断器和 CI。
> 生产环境仍在运行上游 `0.6.6`，本仓库不影响它。

## 为什么重写

原插件在 Windows 上有一批结构性缺陷，不是零散 bug：

- 侧边栏只是把 iframe **直接跳转**到 `127.0.0.1:37986`，只做一次 6 秒提示；
  侧车没起好、端口被占、上一轮进程残留 → 白板，且永不重试。
- Python 子进程按系统默认代码页解码（中文 Windows 是 cp936），worker 的
  UTF-8 JSON 变成乱码或直接抛错。
- vault 写入用「临时文件 + rename」，Windows 上一旦被杀软 / OneDrive / 文件
  句柄拦住就 EBUSY，整个导入失败。
- `chmod 0600` 在 Windows 上是空操作，凭据保护形同虚设。
- 子进程 `kill()` 只杀直接子进程，Python 派生的进程会留下孤儿占住端口。

## 结构

```
src/platform/     唯一允许感知操作系统的层（路径、Python 探测、进程、原子写、日志）
src/protocol/     上游协议实现，**只装箱不改写**（P3 接入）
src/core/         号池 / 凭据 / 额度 / 轮转，纯逻辑，禁止碰 fs 与子进程（P2）
src/adapters/     ProtocolAdapter 实现 + 契约测试 fixtures（P3）
gui/              前端，无构建步骤，ES 模块（P4）
diagnostics/      诊断包生成器（P0，已完成）
test/             node:test，无第三方依赖
baseline/         上游 v0.6.6 快照，仅作对照，不参与构建
```

约束（会在 CI 里逐步变成强制检查）：

1. `src/platform` 之外的模块不得 import `node:os` / `node:child_process`。
2. `src/core` 不得 import `node:fs`。
3. 依赖保持 **0 个 npm 包**。Windows 上的坑有一半来自原生模块。
4. 协议层永远是上游代码，重写只发生在它外面。

设计细节见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，阶段与验收标准见
[docs/ROADMAP.md](docs/ROADMAP.md)。

## 开发

要求 Node ≥ 20，不需要 `npm install`（没有依赖）。

```bash
npm run check     # 语法门禁
npm test          # 31 项单测，Windows/Linux 都通过
npm run diagnose  # 生成诊断包
```

## 在出问题的机器上收集诊断

```bash
node diagnostics/collect.mjs
```

生成 `gptfree-diagnostics-<时间>.json` 与 `.txt`。只读取元数据——账号、Cookie、
Token 一律不碰。`.txt` 可以直接贴出来。

## 许可

MIT，见 [LICENSE](LICENSE)。上游作者与来源见 [NOTICE.md](NOTICE.md)。
