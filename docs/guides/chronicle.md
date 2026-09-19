# 生命年表

「那天发生了什么 / 往年今日 / 上次见到谁」。事件写在 `life/events/`，日记在 `life/diary/`。两者都是知识页，但 **不** 进入 Dream 综合白名单。

本分支已吸收该能力：`src/core/chronicle/`，Schema 含 `event_page_id` 与 `facts.dimension`。自动抽取默认关（`auto_chronicle`）。

## 图形界面

Admin / 桌面「日常 → 生命年表」：选一天看当天事件，以及往年同一天。知识库体检若发现近 30 天会议没有事件投影，会提示用 `pmbrain chronicle-backfill`；一键修复 **不会** 跑回填。

## 命令行

```powershell
pmbrain day 2026-09-19
pmbrain on-this-day
pmbrain since 2026-01-01
pmbrain last-seen people/zhang-san
pmbrain orient
pmbrain ontology people/zhang-san
pmbrain chronicle-backfill
```

`chronicle-backfill` 只在本机（`localOnly`），HTTP MCP 没有这个工具。远程读取会过滤 `life/diary/`。

中文本体别名在写入时规范化，例如 职位 / 职务 / 头衔 → `role`。新维度先隔离。人物当前角色在「日常 → 人物关联」也能看到。
