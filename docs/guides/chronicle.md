# 时间线

「那天发生了什么 / 往年今日 / 上次见到谁」。事件写在 `life/events/`，日记在 `life/diary/`。两者都是知识页，但 **不** 进入 Dream 综合白名单。

本分支已吸收该能力：`src/core/chronicle/`，Schema 含 `event_page_id` 与 `facts.dimension`。自动抽取默认关（`auto_chronicle`）。

## 图形界面

Admin「知识 → 时间线」：选一天看当天事件，以及往年同一天。「设置 → 自动维护」开启后，新会议、对话和日历内容由后台自动整理；首次发现历史内容时会先询问是否整理，不会未经确认修改历史数据。

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

中文本体别名在写入时规范化，例如 职位 / 职务 / 头衔 → `role`。新维度先隔离。人物关联在「待我处理」确认后，人物详情可继续展示当前角色和时间线。
