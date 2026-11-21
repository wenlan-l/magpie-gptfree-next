# 路线图

每个阶段都能独立合并、独立回滚。验收标准写死，做完打勾，没验证就写「未验证」——
不写「基本完成」。

## P0 · 骨架与护栏 ✅

产出：仓库、`src/platform/`、诊断器、双平台 CI、上游快照。

- [x] `npm run check` 与 `npm test` 在 `ubuntu-latest` / `windows-latest` × Node 20/22 全绿
- [x] 诊断包在无依赖、数据目录不存在的环境下也能跑完，且不读取任何凭据
- [x] 上游 v0.6.6 快照入库，作为行为对照（`baseline/`）

## P1 · 生命周期与侧边栏 ✅（真机验证待补）

产出：`lifecycle.mjs`、`/healthz` + `/healthz.png`、确定性端口段回退、入口页状态机、
进程树回收、`killPid`。

- [x] 侧车启动失败不再拖垮插件加载：provider 照常可用，只记一条 warn
- [x] 端口被占自动顺延，页面遍历同一端口段找到它
- [x] 只回收「自己的陈旧进程」：marker + pid 一致 + 进程存活，三条同时满足
- [x] 入口页失败时保留文档，显示探测日志与重试按钮（不再出现白板）
- [x] 单测覆盖状态机每条边（`test/app/lifecycle.test.mjs` 10 例、`test/app/gui-health.test.mjs`）
- [ ] 连续 50 次冷启动无一次卡在「连接中」——**未验证**，需要真机
- [ ] Windows 结束 Magpie 后无残留 `python.exe` / `node.exe`——**未验证**，需要任务管理器

## P2 · 存储、号池、导入 ✅（极端场景待补）

产出：`src/storage/`（加密号池、统计）、`src/app/importer.mjs`、`writeExclusive`。

- [x] 所有写入走 `writeAtomic`（同一 vault 的写操作串行化，25 次并发后仍可解析）
- [x] 密钥文件独占创建，已有密钥绝不被覆盖（`writeExclusive` + 单测）
- [x] 上游 80 项 JS 测试与 14 项 Python 测试移植后全绿，只改了两处布局断言
- [ ] 导入 100 个账号过程中强杀进程，重启后不出现半写 vault——**未验证**（原子写保证单次
      写不撕裂，但没有做断电注入）
- [ ] OneDrive 目录下连续写入 200 次无 EBUSY——**未验证**，需要 Windows 机器

## P3 · 协议边界 ✅（不引入空适配层）

产出：`test/protocol/contract.test.mjs`、`docs/PROTOCOL.md`、`scripts/canary.mjs`。

原计划里有一个 `ProtocolAdapter` 接口。实施时没有加：当前只有一套协议，加一层转发
接口只会变成所有调用都要穿过的死代码。真正需要锁的是**形状**，而形状由契约测试锁：

- [x] 协议模块导出面固定；上层不直接 import 任何 `python/*`
- [x] 报文帧名、模型清单、`requirements.txt` 版本固定
- [x] 协议层不越过 platform 去 `spawn`；不 import `src/app/`
- [x] 契约测试无需账号即可运行
- [x] 协议替换的改动范围被文档化为「换箱子里对应的文件 + 跑测试」
- [ ] 一次真实账号的登录 + 文本 + 生图人工验证——**未验证**（没有账号，也不应该由我烧额度）

## P4 · GUI 重写 ⏸（改为缺陷驱动）

只重写了 `entry.html` / `entry.js`（侧边栏入口与就绪状态机）。`dashboard.html` 与
`app.js` 仍是上游实现：它们能工作，而重写一个 866 行的可用页面、却没有清晰的缺陷清单，
是在制造风险而不是减少风险。

- [x] 入口页无构建步骤、无依赖、首屏立即渲染状态
- [x] 所有失败路径都有可操作提示（端口段被占 / 侧车启动失败 / 加载超时）
- [ ] 内容页模块化——**未做**。触发条件：出现无法在现有结构里修复的缺陷，或需要新增
      与现有页面结构冲突的功能。

## P5 · 巡检自动化 ✅

产出：`scripts/upstream-diff.mjs`、`baseline/UPSTREAM.json`、`.github/workflows/upstream-watch.yml`。

- [x] 上游有新提交 → 按「协议层 / 前端 / 其他」分类，开 issue 或追加评论（不重复开）
- [x] 金丝雀每天运行，零凭据；`MAGPIE_GPTFREE_CANARY_TOKEN` 存在时才追加一次真实文本请求
- [x] 网络受限时判为 `skipped`，不误报协议漂移
- [x] 不自动合并：任何上游合并都要 diff 审查 + 测试全绿 + 人工确认
- [ ] 「连续两次失败才告警」——未做：当前每次运行独立出结果，由 issue/通知呈现

## 明确不做

- 不为了「跟上上游功能」直接抄别的仓库代码；只移植思路，重新实现并补测试。
- 不引入 npm 依赖（原生模块在 Windows 上是主要故障源）。
- 不在无账号验证的情况下宣称「生图可用」。
