# 将技能扩展到 300 个以上而不淹没上下文窗口

当代理增长到超过 100 个技能时，一堵墙开始形成。会话启动时间更长。模型在选择哪个技能时变得有点笨。应该为推理提供动力的令牌正在为模型在每一轮都读取的技能目录提供动力，无论是否需要。

本指南是突破那堵墙而不删除功能的秘诀。三层、一个解析器、一个安全网。在生产环境中经过测试的 306 技能代理（Garry 的 OpenClaw，YC 总裁背后的代理）上进行了测试。无论你运行 OpenClaw、Hermes、Claude Code、Cursor 还是你自己的支持 MCP 的代理，该模式都有效。

## 问题

OpenClaw 在会话启动时扫描磁盘上的每个技能文件，并将它们作为 `<available_skills>` 条目注入系统提示。模型会看到每个技能的名称、描述和文件路径。当请求匹配时，模型会读取完整的 SKILL.md 并遵循它。

这在 50 个技能时是很好的架构。在 100 个时，它很好。在 200 个时，它开始拖沓。在 300 个时，系统提示仅在技能描述上就消耗超过 25,000 个令牌。令牌没有用于推理、上下文或实际工作。

症状会复合：

- 会话启动时间明显变长。
- 模型的对话历史记录空间较小。
- 技能路由变得模糊。有 300 个描述争夺注意力，模型偶尔会选择错误的一个。
- 成本上升，因为每一轮都携带完整的技能清单。

简单的修复方法是删除你不经常使用的技能。不要这样做。技能的全部意义在于能力复合。每月触发两次的礼物管道每次触发时节省 30 分钟。航班跟踪器每次旅行触发一次并防止错过的 Uber。删除低频技能以提示大小为代价优化能力。你不会因为主屏幕太拥挤而删除手机中的应用程序。你会组织它们。

## 三层

并非所有技能都需要随时对模型可见。有些是核心。有些是专业的。有些是休眠的。

### A 层：始终加载（约 35 个技能）

模型在每一轮都需要的技能。Brain 搜索、电子邮件分类、日历、会议摄入、内容创建、执行助理。它们保留在系统提示的 `<available_skills>` 清单中。模型原生看到它们并无路由地路由到它们。

### B 层：解析器路由（约 85 个技能）

真实的、活跃的技能会定期触发，但不需要污染每一轮。礼物管道、航班跟踪器、投资者更新摄入、对手跟踪、书籍镜像、公民情报。它们存在于磁盘上。它们有完整的 SKILL.md 文件。但 OpenClaw 不会将它们注入提示。

相反，一个紧凑的 RESOLVER.md 处理路由。每个技能一行，带有触发短语：

```markdown
- **gift-advisor**: gift idea | what should I bring | birthday gift | housewarming
- **flight-tracker**: track my flight | flight status | when does my flight land
- **investor-update-ingest**: investor update | portfolio update | company metrics
```

当模型看到"我应该带什么去 Jessica 的晚餐"时，它会检查解析器，找到 `gift-advisor`，读取 SKILL.md，然后执行。同样的结果。在其他 84 轮礼物不相关的场合，零浪费的令牌。

### C 层：休眠（约 180 个技能）

内置的 OpenClaw 技能不在主动轮换中（1Password、Discord、Notion、Trello、你尚未连接的集成）以及几乎从不触发的专业技能。它们使用 `enabled: false` 在配置中被明确禁用。它们作为文档和潜力存在于磁盘上。翻转一个布尔值即可唤醒它们。在那时之前，零令牌贡献给每个提示。

### 数字

在分层之前，在 Garry 的 306 技能 OpenClaw 上：

| 指标 | 之前 |
|------|------|
| 系统提示中的技能 | 306 |
| 每轮技能描述令牌 | ~25,000 |
| 技能路由准确性 | 下降 |
| 会话启动 | 慢 |

分层后：

| 指标 | 之后 |
|------|------|
| 系统提示中的技能（A 层） | 35 |
| 每轮技能描述令牌 | ~4,000 |
| 仍可访问的技能（A + B + C） | 301 |
| 能力损失 | 零 |
| **每轮释放的令牌** | **~21,000** |

每轮 21K 令牌不是小的优化。这是模型有思考空间与模型被挤压之间的区别。这是携带 3 页对话历史记录与携带 15 页之间的区别。

## 解析器实际做什么

解析器比清单便宜。这是负载-bearing 的见解。

OpenClaw 的原生技能清单将每个技能约 80 个令牌放入系统提示（名称 + 描述 + 位置）。在 300 个技能时，无论模型是否需要目录，每轮都会花费 24,000 个令牌。

解析器将每个技能约 15 个令牌放入紧凑的 markdown 列表。在 300 个技能时，那是 4,500 个令牌。但它只在模型检查它时触发，这只有当请求与 A 层技能不匹配时才会发生。大多数轮次，解析器的成本为零，因为 A 层匹配处理了它。

这是路由表模式，但应用于技能清单本身。解析器路由到技能，但它也绕过技能，在需要之前将它们保持在上下文窗口之外。

GBrain 附带来 Bundled `skills/RESOLVER.md`，你可以用作参考形状。跨机器分发你自己的解析器的技能包故事包含在 [skillpacks as scaffolding](skillpacks-as-scaffolding.md) 中。

## 紧凑列表格式（v0.41.7.0）

GBrain 的解析器解析器过去需要 markdown 表：

```markdown
| Trigger | Skill |
|---------|-------|
| "gift idea" | `skills/gift-advisor/SKILL.md` |
```

当你有 20 个条目时这很好。在 200 个时它变得难以处理，在 300 个时它是不可读的。OpenClaw 部署悄悄地演变成了一种更能扩展的紧凑列表格式：

```markdown
- **gift-advisor**: gift idea | what should I bring | birthday gift
- **flight-tracker**: track my flight | flight status | when does my flight land
```

在 v0.41.7.0 之前，`gbrain doctor` 只说表方言。在 306 技能紧凑格式解析器上，doctor 将每个技能报告为无法访问：**每次 doctor 运行时有 238 个 FAIL 错误**。解析器默默地将在紧凑方言视为零技能。

v0.41.7.0 提供双格式支持。同一个 `parseResolverEntries` 函数读取同一文件中的表行和列表行，v0.31.7 多解析器合并（技能包 `skills/RESOLVER.md` + 工作区 `../AGENTS.md`）将所有内容折叠到一个统一视图中。运行 `gbrain doctor`，238 个 FAIL 崩溃为 0。

### 列表格式合约

几条规则使解析器明确：

- **技能名称必须是 kebab 小写。** `gift-advisor`、`flight-tracker`、`email-triage`。以大写字母开头的名称（`MyTool`、`Note`、`Convention`）被故意忽略。这阻止了散文项目符号如 `- **Note**: see [link]` 在实际的 AGENTS.md 文件中被错误解析为技能行。
- **路径总是解析为 `skills/<name>/SKILL.md`。** 允许可选的 `→ \`skills/path\``（或 ASCII `->`）后缀以提高可读性，但解析器会剥离它。对于非常规路径（嵌套目录下的技能、对 `conventions/` 的引用、任何不是 `skills/<name>/SKILL.md` 的内容），请使用表格式。
- **触发器用 `|` 分隔。** 空部分和文字 `...` 占位符被丢弃。每个触发器成为自己的解析器条目，都指向同一个技能。
- **粗体或普通。** `- **name**: triggers` 是首选。`- name: triggers` 作为后备工作。

你可以在同一文件中混合使用表格和列表行。当 brain 从 gbrain 继承表格格式的 `RESOLVER.md` 并从 OpenClaw 继承列表格式的 `../AGENTS.md` 时，这很有用。

## doctor 安全网

分层的危险是看不见的技能损失。你从原生扫描禁用技能，忘记将其添加到解析器，现在代理无法执行它过去可以做的事情。在你需要的那一刻之前，你不会注意到。

`gbrain doctor` 遍历磁盘上的每个技能，并验证它是可访问的，要么通过原生扫描（A 层），要么通过解析器（B 层和 C 层）。在 Garry 的设置上，分层后的第一次运行发现了 63 个无法访问的技能。63 个存在于磁盘上但没有路由路径的功能。通过在一小时内添加解析器条目修复。

在每次技能更改后运行它：

```bash
gbrain doctor
```

对于 CI 门，请使用发出 JSON 的变体：

```bash
gbrain check-resolvable --json
gbrain check-resolvable --strict  # 警告也失败
```

如果某个技能无法访问，输出会告诉你哪个以及如何修复。解析器是一个文档。文档的修复成本很低。

## 实施演练

三项更改。一旦你决定了哪些技能进入哪个层，总时间约为 45 分钟。

### 1. 审计和分层你的技能

遍历每个技能。问：这需要在每一轮触发吗？

- 如果是 → A 层。
- 如果它每周或更少触发但是真实 → B 层。
- 如果你不使用它 → C 层。

### 2. 在你的代理配置中禁用 B 层和 C 层

对于 OpenClaw，文件是 `openclaw.json`。为每个禁用的技能添加一个条目：

```json
{
  "skills": {
    "entries": {
      "gift-advisor": { "enabled": false },
      "flight-tracker": { "enabled": false },
      "1password": { "enabled": false }
    }
  }
}
```

确切的配置形状取决于你使用的代理运行时。在所有这些中的要点是相同的：告诉运行时不要将此技能注入系统提示。文件保留在磁盘上；只有提示注入停止。

### 3. 编写解析器

B 层和 C 层技能每个一行。触发短语匹配你实际要求的方式：

```markdown
- **gift-advisor**: gift idea | what should I bring | birthday gift
- **flight-tracker**: track my flight | flight status | when do I land
- **investor-update-ingest**: investor update | portfolio update | company metrics
```

就是这样。模型处理其余部分。当请求与 A 层不匹配时，它会检查解析器，读取匹配的 SKILL.md，然后执行。

### 4. 运行 `gbrain doctor` 并修复任何无法访问的技能

doctor 扫描会告诉你哪些技能没有路由路径。为每个添加一个解析器条目，重新运行，重复直到计数为零。

## 第一版的教训

我最初将我的解析器从干净的列表格式转换为表格格式，因为验证器只说表格。那是错的。当工具对有效数据失败时，正确的举动是修复工具，而不是重塑数据。列表格式是正确的、紧凑的、可读的、易于维护的。解析器需要支持两种形状。v0.41.7.0 就是那个修复。

同样的原理适用于代理系统中的任何地方。你的 SKILL.md 是事实的来源。你的 AGENTS.md 是事实的来源。你的解析器是事实的来源。当工具与你的配置不一致时，工具是错误的。修复工具。

## 扩展曲线

在 50 个技能时，你不需要这些中的任何一个。只需加载所有内容。

在 100 个时，你开始感觉到阻力，但可以继续推进。

在 200 个时，路由准确性下降，会话明显变慢。这是大多数人停止添加技能的地方，这意味着他们的代理停止变得更有能力。糟糕的权衡。

在 300+ 时，分层是强制性的。但是通过分层，没有天花板。1,000 个技能，其中 35 个在热路径中，965 个在解析器中，每轮成本与没有解析器的 35 个技能相同。成本保持平稳。能力复合。

让你从 50 到 300 的架构与让你从 10 到 50 的架构不同。这很正常。扩展的系统会改变形状。重要的是每个层都保留完整的能力。你正在组织，而不是删除。

## 相关

- [Skill development cycle](skill-development.md) — 将重复任务转变为真实技能的 5 步循环。
- [Skillpacks as scaffolding](skillpacks-as-scaffolding.md) — 如何跨机器和代理分发连贯的技能集。
- [Sub-agent routing](sub-agent-routing.md) — 何时委托给子代理 vs 内联处理，以及每种路径的模型路由表。

GBrain: [github.com/garrytan/gbrain](https://github.com/garrytan/gbrain)。
`parseResolverEntries` 解析器位于 [`src/core/check-resolvable.ts`](../../src/core/check-resolvable.ts)；bundled 解析器位于 [`skills/RESOLVER.md`](../../skills/RESOLVER.md)。
