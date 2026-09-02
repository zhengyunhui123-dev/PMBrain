---
name: pmbrain-advisor
version: 1.0.0
description: |
  PMBrain 知识库健康管家。用户询问“知识库健康”“大脑体检”或“现在最该处理什么”时，运行
  `pmbrain advisor`，按严重度汇报版本、迁移、任务、同步、向量和配置问题。默认只读，执行修复前必须取得用户确认。
triggers:
  - "知识库健康"
  - "大脑体检"
  - "pmbrain advisor"
  - "现在最该处理什么"
tools:
  - advisor
mutating: false
---

# PMBrain Advisor

> **Convention:** 遵循 `skills/conventions/brain-first.md`。Advisor 负责告诉知识库所有者当前最值得处理的健康问题，不替用户擅自修改知识库。

## Contract

- 默认运行 `pmbrain advisor --json`，按 `critical` → `warn` → `info` 汇报最重要的 1–3 项。
- Advisor 报告本身只读。展示准确的 `fix.command_argv`，执行任何修复前先征得用户明确同意。
- 只有 finding 含 `fix.dispatch_id` 时才能在确认后使用 `pmbrain advisor --apply <dispatch_id>`；该入口仍受结构化命令白名单保护。
- 使用本地运行历史说明哪些问题是新增或已解决的，避免反复提醒未变化的低优先级项目。
- MCP `advisor` 只返回知识库状态；是否发布由 `mcp.publish_advisor` 控制。

## 当前覆盖范围

当前 PMBrain Advisor 检查版本缓存、待执行迁移、Schema Pack、停滞任务、过期同步、向量覆盖率和配置异常。不要声称它已经覆盖 GBrain 的 Chronicle、未安装 Skill/brain-pack、备份覆盖率或 MCP 客户端适配检查。

## Output Format

1. 先说明最高严重度及其用户影响。
2. 列出最重要的 1–3 项和对应修复命令。
3. 对可执行项明确询问是否处理；未获同意不得运行。
4. 没有问题时只需说明“知识库当前没有紧急健康问题”，不要制造待办。

如果用户明确要求定期体检，使用 `skills/cron-scheduler/SKILL.md` 安排每周一次的只读 `pmbrain advisor --json`；仅在出现 critical 或新增问题时提醒，修复仍需再次确认。

## Anti-Patterns

- 不得因为 Advisor 给出建议就自动运行迁移、补向量、同步或孤立页整理。
- 不得向用户倾倒未经整理的完整 JSON。
- 不得把 `info` 当成阻断性问题。
- 不得把当前未实现的上游 collectors 描述为已经检查通过。
