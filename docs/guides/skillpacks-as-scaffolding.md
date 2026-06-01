# 技能包作为脚手架，而不是琥珀

GBrain v0.33 将 `gbrain skillpack` 从包管理器重塑为脚手架 + 参考库。本指南解释模型和工作流。

## 我们为什么改变它

v0.33 之前（"琥珀"模型）：

- `gbrain skillpack install <name>` 将 bundled 技能复制到你的工作区，并在你的 `RESOLVER.md` / `AGENTS.md` 中写入一个 managed-block 围栏，并带有 `cumulative-slugs="..."` 收据。
- 后续安装进行哈希检查每个文件，并拒绝覆盖本地编辑，除非你传递 `--overwrite-local`。
- `gbrain skillpack uninstall` 有自己的数据丢失保护措施（D8 收据门 + D11 内容哈希预扫描）并重建围栏。

它工作了，但它将个人 AI 技能视为供应商包。用户无法干净地 fork 技能，而后续的安装会与他们斗争。每次发布都会重新审理同一个托管块。仅托管块的测试表面就约 1000 行。

技能不是供应商包。它们是你的代理仓库中的一级代码。你脚手架一次，你拥有它们，你自由地 fork 和编辑。当 gbrain 发布新版本时，你会问"什么改变了？" — 代理读取差异并决定要集成什么（如果有的话）。

## 五个命令

### `gbrain skillpack scaffold <name> [--workspace PATH]`

一次性、附加地将 bundled 技能复制到你的仓库。拒绝覆盖任何存在的文件。路由来自每个技能的前置事务 `triggers:` 数组 — gbrain 不触碰你的 `RESOLVER.md` 或 `AGENTS.md`（见下面的"代理如何发现脚手架技能"）。

```bash
cd ~/git/your-agent-repo
gbrain skillpack scaffold book-mirror
# skills/book-mirror/ 中的文件 +（如果技能声明配对的源）
# src/commands/book-mirror.ts 降落在你的工作区
```

`scaffold --all` 复制每个缺失的 bundled 技能。从不修剪。

如果技能的前置事务声明了配对源文件（SKILL.md YAML 头中的 `sources: [...]`），脚手架也会复制它们。部分状态策略处理"技能更早发布，后来获得了配对源" — 即使技能目录已经存在，脚手架也会复制新的配对文件。

### `gbrain skillpack reference <name> [--workspace PATH] [--apply-clean-hunks] [--json]`

只读更新镜头。将 gbrain 的包与你的本地副本进行比较，并发出每个文件状态（`identical` / `differs` / `missing`）以及任何 `differs` 条目的统一差异。

```bash
gbrain skillpack reference book-mirror
# 这些文件作为参考位于 <gbrain-path>。读取它们并
# 决定要集成什么（如果有的话）到你的本地 skills/。
# 你的本地编辑是故意的 — 不要盲目覆盖。
#
# reference: identical:14 differs:1 missing:0
#
#   differs   /your/workspace/skills/book-mirror/SKILL.md
#   --- a/skills/book-mirror/SKILL.md
#   +++ b/skills/book-mirror/SKILL.md
#   @@ -10,3 +10,5 @@
#   ... unified diff ...
```

`reference --all` 扫描整个包（每个技能一行摘要）。

`reference <name> --apply-clean-hunks` 是自动应用路径。它解析 gbrain 的包与你的本地副本之间的差异，应用每个其预更改上下文唯一匹配的 hunk。**双向合并限制**：没有脚手架时基跟踪（v0.33 有意超出范围），这无法区分"gbrain 更改了 X"与"你更改了 X"。应用 hunk 会将所有内容对齐到 gbrain。首先使用 `--dry-run` 进行预览，或者在让自动应用触碰任何内容之前运行普通 `reference` 以检查差异。

### `gbrain skillpack migrate-fence [--workspace PATH] [--dry-run]`

对工作区在 v0.33 之前托管块模型的一次性转换。从你的解析器文件中剥离 `<!-- gbrain:skillpack:begin -->` / `end -->` 标记和清单收据注释。

**逐字保留围栏内的每一行。** 这些行成为用户拥有的路由，代理在过渡到基于前置事务的发现期间仍然可以看到。

```bash
cd ~/git/your-agent-repo
gbrain skillpack migrate-fence
# migrate-fence: fence_stripped
#   resolver: /your/workspace/skills/RESOLVER.md
#   fenced slugs: alpha, beta, gamma
#   already present: alpha, beta
#   skills copied: gamma   (additive — beta and alpha kept their local edits)
```

幂等。迁移后重新运行会找不到围栏并以 0 退出。

### `gbrain skillpack scrub-legacy-fence-rows [--workspace PATH] [--dry-run]`

选择加入清理。一旦你确认你的代理遍历前置事务 `triggers:` 进行路由，此命令会删除 `migrate-fence` 留下的遗留行。

**双条件门**（两个条件都必须成立才能删除行）：

1. `skills/<slug>/` 存在于主机上（它是真实的脚手架）。
2. 该技能的前置事务声明了非空的 `triggers:`（证明前置事务发现覆盖了此技能）。

slug 失败任一条件的行被保留 — 用户拥有的路由迁移不应该触碰。

### `gbrain skillpack harvest <slug> --from <host-repo-root> [--no-lint] [--dry-run]`

脚手架的逆操作：将经过验证的技能从你的主机仓库提升回 gbrain，以便其他客户端可以脚手架它。默认行为：

- 主机技能目录中的符号链接被拒绝（规范路径限制）。
- 隐私 linter 根据 `~/.gbrain/harvest-private-patterns.txt` 以及内置默认值（规范私有 fork 名称、常见电子邮件正则表达式、Slack 频道模式）扫描收获的文件。任何匹配 → 回滚（删除收获的文件）并以非零退出。
- `openclaw.plugin.json` 使用新的 slug 更新，已排序。
- `--no-lint` 绕过 linter（在手动编辑清理之后）。

使用 `skillpack-harvest` 技能（其配套编辑工作流）在运行 CLI 之前遍历通用化检查清单。

## 代理如何发现脚手架技能

新模型下的路由完全存在于每个技能的前置事务中：

```yaml
---
name: book-mirror
triggers:
  - "personalized version of this book"
  - "mirror this book"
  - "two-column book analysis"
---
```

你的代理在运行时的任务是遍历 `skills/*/SKILL.md`，解析前置事务，并将用户的意图与每个技能的 `triggers:` 数组进行匹配。当匹配得分足够高时，调用该技能。

这取代了 v0.32 模型，其中 `gbrain skillpack install` 将表行写入你的 `RESOLVER.md`。行消失了（或者，对于从旧模型迁移的用户，由 `migrate-fence` 过渡保留，直到它们运行 `scrub-legacy-fence-rows`）。

如果你是将此模型更新的下游代理作者：

1. 在启动时，扫描 `skills/*/SKILL.md` 以查找前置事务。
2. 从每个技能的 `triggers:` 数组构建内存中路由表。
3. 在每条用户消息上，针对此表进行匹配 — 通过子字符串包含、语义相似性或者你的下游代理已经为意图分类做的任何事情。

## 移除脚手架技能

v0.33 中没有 `gbrain skillpack uninstall` 命令。你的 `skills/<slug>/` 中的文件是你仓库的一级成员 — 像任何其他代码一样删除它们：

```bash
rm -rf skills/book-mirror
# 如果技能声明了配对源文件：
rm src/commands/book-mirror.ts
# （请查阅技能的前置事务 `sources:` 数组以获取完整列表）

# 如果没有其他脚手架技能需要它们，你也可以删除
# 脚手架丢弃的共享依赖项：
rm skills/_brain-filing-rules.md
rm -rf skills/conventions/
rm skills/_output-rules.md
```

你拥有文件。没有清单要更新，没有围栏要重建。

## 何时使用哪个命令（快速决策树）

- **新的主机仓库，想要 gbrain 技能** → `scaffold`
- **gbrain 发布了新版本，想要看看什么改变了** → `reference`（只读）或 `reference --apply-clean-hunks`（自动）
- **从 v0.32 或更早升级** → `migrate-fence`（一次性）
- **`migrate-fence` 后清理** → `scrub-legacy-fence-rows`
- **将你的 fork 的技能提升回 gbrain** → `harvest` + `skillpack-harvest` 编辑技能

## `install` 和 `uninstall` 怎么样？

两者都在 v0.33 中移除。运行任一命令都会打印指向替换命令的错误。没有弃用的别名 — 这是一个干净的断开。如果你有引用旧名称的现有脚本，请更新它们一次然后继续。
