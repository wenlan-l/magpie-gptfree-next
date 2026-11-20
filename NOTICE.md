# 第三方代码来源

## magpie-gptfree（上游）

- 仓库：https://github.com/yang0/magpie-gptfree
- 许可证：MIT（`package.json` 声明；上游仓库未附带 LICENSE 文件）
- 本仓库 `baseline/upstream-0.6.6/` 是 **v0.6.6 的完整快照**，取自部署实例中
  实际安装的 `node_modules/magpie-gptfree`，用于：
  1. 记录重构前的确切行为；
  2. 作为回归测试的对照基线；
  3. 在协议层被替换前，保留可直接复用的 worker 实现。

该目录 **不参与构建、不被加载**，仅作参考。基线中的 Python worker 依赖
`curl_cffi`、`requests` 等第三方包，其许可证见
`baseline/upstream-0.6.6/python/THIRD_PARTY.md` 与 `THIRD_PARTY_LICENSE.txt`。

上游声明的 MIT 许可证要求保留版权与许可声明，因此本仓库 LICENSE 同时列出
上游贡献者。原作者的版权归其本人所有。
