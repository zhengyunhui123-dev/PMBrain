# Memorable

产品决定：Memorable **已吸收，不再暂缓**。SkillOpt 仍不移植。

**本分支没有合入代码。** `execute-plan/dce9287a-pr-12-docs-and-ledgers-lift-deferrals` 以 PR11 为底，目录里没有 `src/core/memorable`，也没有 `integrations.memorable` 接线。实现在 sibling：

`execute-plan/dce9287a-pr-8-memorable-opt-in-integration`

那边是默认关闭的三开关同意模型（Memorable CLI 同意、`integrations.memorable.enabled`、本机披露戳），外加 `PMBRAIN_MEMORABLE=0` 总闸。合入 PR8 之前，不要运行 `memorable enable`，也不要为了「方便」去读 `~/.gbrain`——1.3.61 起 PMBrain Home 与 GBrain 隔离。
