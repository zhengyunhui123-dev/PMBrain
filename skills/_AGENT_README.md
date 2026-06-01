# 智能体入门 — 如何处理本目录中的文件

您（智能体）运行在一个已在此部署 gbrain 技能的宿主机上。本文件是操作契约。每次冷启动时阅读它。它刻意保持简短。

## 本目录中有什么

```
skills/
  _AGENT_README.md          ← 您在这里
  _brain-filing-rules.md    ← 大脑页面的存放位置规则（每次写入时阅读）
  _output-rules.md          ← 输出质量标准（禁止 LLM 套话，精确保留原始措辞）
  _friction-protocol.md     ← 将用户遇到的摩擦记录到 ~/.gstack/friction/
  conventions/              ← 每个技能都遵循的跨领域规则
  <skill-name>/
    SKILL.md                ← 技能的契约和工作流
    routing-eval.jsonl      ← （可选）路由评估的测试夹具
    script.ts               ← （可选）确定性代码（如有）
```

宿主仓库中的 `src/`、`docs/`、`recipes/` 等其他文件由宿主拥有，而非 gbrain。不要将它们视为 gbrain 制品。

## 路由 — 您的首要任务

在运行时通过遍历此处的每个 `skills/<slug>/SKILL.md` 并解析 YAML 前置元数据来发现技能。每个技能声明一个或多个 `triggers:` 字符串；它们是路由到该技能的用户面向短语。

```yaml
---
name: book-mirror
triggers:
  - "personalized version of this book"
  - "mirror this book"
  - "two-column book analysis"
---
```

每收到一条用户消息时，将消息与每个技能的 `triggers:` 数组进行匹配。子字符串匹配是基线。在此之上可以使用语义相似度（嵌入或关键词扩展）。当触发器强烈匹配时，调用该技能——完整阅读其 `SKILL.md` 正文并遵循其中描述的工作流。

**不要**在 `RESOLVER.md` 或 `AGENTS.md` 中查找托管块表。该模式在 gbrain v0.36 中已弃用。路由现在位于前置元数据中。

## 当用户调用技能时

完整阅读 `skills/<slug>/SKILL.md` 文件。遵循其 `## Phases`、`## Workflow` 或等效的分步章节。如果 SKILL.md 前置元数据声明了 `mutating: true` 并声明了 `writes_pages:` / `writes_to:`，这些是大脑侧的写入面——查阅 `_brain-filing-rules.md` 确认文件路径是被认可的。

如果 SKILL.md 前置元数据声明了 `sources:`（配对的源文件），它们位于宿主仓库中的镜像路径（例如 `src/commands/<slug>.ts`）。它们是 gbrain CLI 调用的参考代码。除非 SKILL.md 告诉您，否则不要直接运行它们。

## 更新 — 当 gbrain 发布新版本时

用户运行 `gbrain upgrade`。技能文件不会自动更改。gbrain 变成您用来比较的参考库。

每次冷启动时，或用户提到升级时，运行：

```bash
gbrain skillpack reference --all
```

这会扫描每个内置技能并报告每个技能的 `identical / differs / missing` 计数。对于每个 `differs`：

```bash
gbrain skillpack reference <slug>
```

这会打印 gbrain 的包与本地文件之间的统一差异。阅读它，然后逐个文件决定：

- **本地编辑是有意为之。** 保留您的版本。gbrain 是参考，而非规范。
- **本地编辑是意外偏移**（例如您将过时内容写入了技能正文）。手动修补，或运行 `gbrain skillpack reference <slug> --apply-clean-hunks`（请先阅读下面关于双向合并的警告）。
- **确实是在您不关心的部分中 gbrain 的新变更。** 跳过或按您的判断应用。

对于 `missing` 文件（gbrain 自您部署以来添加了新的内置技能），运行 `gbrain skillpack scaffold <new-slug>` 来引入它。

### `reference --apply-clean-hunks` — 双向合并警告

此命令对 gbrain 当前的包执行双向差异比较。它无法访问您最初部署时的版本。后果：如果用户的本地文件在任何部分与 gbrain 不同（包括有意的用户编辑），这些部分将被对齐到 gbrain。

始终先运行普通的 `gbrain skillpack reference <slug>` 进行检查。仅当您确信本地编辑是意外的或您想完全重置为 gbrain 当前包时，才使用 `--apply-clean-hunks`。

## 移除已部署的技能

v0.36 中没有 `uninstall` 命令。文件属于您。

```bash
rm -rf skills/<slug>
# 如果技能声明了配对的源文件：
rm src/commands/<slug>.ts
```

删除前请查阅技能前置元数据中的 `sources:` 数组以获取完整的配对文件列表。

## 有疑问时

模型的唯一事实来源是 gbrain 仓库中的 `docs/guides/skillpacks-as-scaffolding.md`。您部署的技能文件是各个技能行为的事实来源。本文件（`_AGENT_README.md`）是路由契约——保持简短。
