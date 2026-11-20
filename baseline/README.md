# 上游基线快照

`upstream-0.6.6/` 是 magpie-gptfree v0.6.6 的完整源码快照，取自实际运行实例中
安装的 `node_modules/magpie-gptfree`（与上游提交 `5ab9b99` 一致）。

用途：

- 记录重构前的确切行为，出现"以前可以"的争议时以此为准；
- 作为回归测试的对照（跑它的 80 项 JS 测试 + 14 项 Python 测试）；
- Python worker 在被替换前可直接复用。

**不参与构建，不被加载，CI 也不会执行这里的测试。**

重新生成快照：

```bash
docker cp <容器>:/config/magpie/plugins/node_modules/magpie-gptfree ./upstream-0.6.6
rm -rf ./upstream-0.6.6/{.git,.bun-tag,python/utils/__pycache__}
```

来源与许可见仓库根目录 `NOTICE.md`。
