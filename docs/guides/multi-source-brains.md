# 多源 Brains

**一个 gbrain 数据库可以容纳多个知识仓库。** 每一个都是一个 `source`（源）：一个逻辑上的"brain 中的 brain"，拥有自己的 slug 命名空间、自己的同步状态和自己的联邦策略。本指南的其余部分将介绍三个典型场景。

## 三个场景

### 1. 统一知识召回（wiki + gstack）

你有一个个人 wiki 和一个 `gstack` 检出目录。两者都属于你，都是你希望 agent 能够跨源回忆的知识。当你问"关于 X 我学到了什么？"时，你希望无论结果是在 wiki 中还是在 gstack 计划中，都能获得最佳匹配。

```bash
# 注册 gstack 源，启用联邦使其加入跨源搜索
gbrain sources add gstack --path ~/.gstack --federated

# 固定目录，使 `gbrain sync` 知道它正在遍历哪个源
cd ~/.gstack && gbrain sources attach gstack

# 初始同步
gbrain sync --source gstack

# 现在 `gbrain search "retry budgets"` 返回 wiki 和
# gstack 中的结果。每个结果都包含 source_id，以便 agent 正确引用。
```

结果：wiki 页面和 gstack 计划是分开的（不同的 source_ids，不同的 slug 命名空间），但共享搜索表面。

### 2. 用途分离的 brains（yc-media + garrys-list）

你在同一个后端上运行两个完全不同的内容管道。YC Media 覆盖投资组合新闻和创始人资料。Garry's List 是个人写作。你明确不希望它们在搜索中混合 — YC 投资组合内容泄漏到文章搜索中是一个 bug，而不是功能。

```bash
# 两个源，都是隔离的（federated=false）
gbrain sources add yc-media --path ~/yc-media --no-federated
gbrain sources add garrys-list --path ~/writing --no-federated

# 固定每个检出目录
(cd ~/yc-media && gbrain sources attach yc-media)
(cd ~/writing && gbrain sources attach garrys-list)

# 独立同步每个源
gbrain sync --source yc-media
gbrain sync --source garrys-list
```

结果：从两个目录中的任何一个进行搜索都不会返回 `default` 源（你的主 brain）。从 `~/yc-media` 内部搜索只返回 yc-media 的结果。从 `~/writing` 内部搜索只返回 garrys-list。联邦是选择加入的，不会泄漏。

要按需显式跨源搜索：

```bash
gbrain search "tech layoffs" --source yc-media,garrys-list
```

### 3. 混合模式（wiki 联邦 + sessions 隔离）

你的主 wiki 与几个受信任的源联邦。你的会话记录（v0.18 即将推出）存放在一个单独的隔离源中，这样它们就不会主导每个搜索结果。

```bash
# 联邦源
gbrain sources add gstack --path ~/.gstack --federated

# 隔离源（未来的 v0.18 — sessions 今天使用这种形式进行摄取）
gbrain sources add sessions --path ~/.claude/sessions --no-federated
```

## 解析优先级

当任何命令需要选择一个源时，gbrain 按此列表顺序遍历（优先级最高在前）：

1. 显式的 `--source <id>` 标志。
2. `GBRAIN_SOURCE` 环境变量。
3. CWD 或任何祖先目录中的 `.gbrain-source` 点文件。
4. 其 `local_path` 包含 CWD 的已注册源（嵌套检出的最长前缀获胜）。
5. 通过 `gbrain sources default <id>` 设置的 brain 级默认值。
6. 种子 `default` 源。

因此，在通过 `.gbrain-source` 将 `gstack` 固定到 `~/.gstack` 的 brain 中，`~/.gstack/plans/` 内部，`gbrain put-page` 隐式写入 `gstack` 源。在任何已注册目录外，没有设置 env/点文件时，它写入默认值。

## 联邦标志

每个源行在其 JSONB 配置中存储 `config.federated: boolean`。

| 值 | 含义 |
|-------|---------|
| `true` | 源参与无限定 `gbrain search "X"` 结果。 |
| `false`（新源默认值） | 源仅在通过 `--source <id>` 或限定引用显式命名时搜索。 |

种子 `default` 源是 `federated=true`，因此 pre-v0.17 brains 的行为与以前完全相同 — 每个页面都出现在搜索中。

稍后可以使用 `gbrain sources federate <id>` / `unfederate <id>` 切换。

## 命令

完整的子命令参考：

```
gbrain sources add <id> --path <p> [--name <n>] [--federated|--no-federated]
                              注册一个源。id: [a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?
gbrain sources list [--json]   列出所有源及其页面计数 + 联邦状态。
gbrain sources remove <id> [--yes] [--dry-run] [--keep-storage]
                              级联删除一个源（页面、块、时间线）。
gbrain sources rename <id> <new-name>
                              仅更改显示名称；id 是不可变的。
gbrain sources default <id>    设置 brain 级默认值。
gbrain sources attach <id>     在 CWD 中写入 .gbrain-source（类似于 kubectl context）。
gbrain sources detach          从 CWD 中删除 .gbrain-source。
gbrain sources federate <id>
gbrain sources unfederate <id>
```

## Agent 的引用格式

当 agent 收到多源结果时，它们必须以 `[source-id:slug]` 形式引用页面。示例：

> 你告诉过我关于蒸馏协议的信息 — 参见 [wiki:topics/ai]
> 和 [gstack:plans/multi-repo] 了解来源。

引用键是 `sources.id`（不可变）。通过 `gbrain sources rename` 重命名源仅更改显示名称；现有引用继续工作。

## 写入特定源

```bash
# 显式传递 --source
gbrain put-page topics/ai ... --source wiki

# 或者依赖点文件 / env / CWD 匹配
cd ~/.gstack && gbrain put-page plans/multi-repo ...
# → 源自动解析为 gstack
```

读取默认跨联邦源。写入需要解析的源（显式、推断或默认）。解析器在模棱两可时永远不会静默选择源 — 它会报错并提供明确的修复方法。

## 升级现有 brain

`gbrain upgrade` 自动运行 v16 + v17 迁移。你的现有页面都移动到 `source_id='default'` 下。在添加第二个源之前，行为不变。

要添加一个：

```bash
gbrain sources add gstack --path ~/.gstack --federated
cd ~/.gstack && gbrain sources attach gstack && gbrain sync
```

两个命令。现有默认源不受影响。

## 不在 v0.18.0 中的功能

- 会话记录摄取（`.jsonl`、提高的大小限制、会话 PageType）— v0.18。
- 每源保留/TTL（`gbrain sources prune`）— v0.18。
- 通过调用者身份执行 ACL — v0.17.1。
- `gbrain sources import-from-github <url>` 一次性引导 — 核心管道稳定后的补丁发布。

所有这些都基于此处发布的 `sources` 原语。

---
*是 [GBrain Skillpack](../GBRAIN_SKILLPACK.md) 的一部分。*
